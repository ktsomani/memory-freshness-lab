import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { VoiceCall, createArchivedLookup, recognizeQuestion } from "./call.js"
import { loadFixture } from "./fixture.ts"
import { liveVoiceSessions } from "./live.ts"
import { createSupermemory } from "../../src/transport.ts"
import type { MemoryTransport } from "../../src/transport.ts"

const dir = fileURLToPath(new URL("../../results/four-fact-holdout", import.meta.url))
const archive = loadFixture(dir, "airport")
const times = { latencyMs: 0 }
const fixture = {
  ...archive,
  before: { ...archive.before, ...times },
  after: { ...archive.after, ...times },
  history: { ...archive.history, ...times },
}

test("a background correction changes fresh recall without restarting the call", async () => {
  const frozen = new VoiceCall({ fixture, policy: "frozen", lookup: createArchivedLookup(fixture) })
  const fresh = new VoiceCall({ fixture, policy: "turn-lookup", lookup: createArchivedLookup(fixture) })
  assert.equal((await fresh.ask("current"))?.value, "Oakland")
  frozen.correct()
  fresh.correct()
  assert.equal((await frozen.ask("current"))?.value, "Oakland")
  assert.equal((await fresh.ask("current"))?.value, "San Jose")
  assert.equal((await fresh.ask("historical"))?.value, "Oakland")
})

test("a deadline asks the caller to confirm and suppresses a late response", async () => {
  const events: string[] = []
  const call = new VoiceCall({
    fixture, policy: "turn-lookup", budgetMs: 15,
    lookup: async () => { await delay(45); return fixture.after },
    emit: (event: { type: string }) => events.push(event.type),
  })
  call.correct()
  const response = await call.ask("current")
  assert.equal(response?.outcome, "deadline")
  assert.equal(response?.value, null)
  assert.match(response?.spoken ?? "", /Can you confirm/)
  await delay(50)
  assert.equal(events.filter((event) => event === "answer-ready").length, 1)
})

test("interrupting a turn prevents it from releasing audio after a new turn starts", async () => {
  const committed: number[] = []
  const call = new VoiceCall({
    fixture, policy: "turn-lookup",
    lookup: async ({ question }: { question: string }) => {
      if (question === "current") await delay(30)
      return fixture.after
    },
    emit: (event: { type: string; id?: number }) => {
      if (event.type === "answer-ready") committed.push(event.id!)
    },
  })
  const old = call.ask("current")
  const latest = call.ask("historical")
  assert.equal(await old, null)
  assert.equal((await latest)?.id, 2)
  await delay(40)
  assert.deepEqual(committed, [2])
})

test("a correction or hang-up invalidates an in-flight answer", async () => {
  const call = new VoiceCall({
    fixture, policy: "turn-lookup",
    lookup: async () => { await delay(25); return fixture.before },
  })
  const beforeCorrection = call.ask("current")
  call.correct()
  assert.equal(await beforeCorrection, null)
  const beforeEnd = call.ask("current")
  call.close()
  assert.equal(await beforeEnd, null)
  await assert.rejects(call.ask("current"), /ended/)
})

test("only supported current or historical questions become live lookups", () => {
  assert.equal(recognizeQuestion("What is my current airport?", archive.field), "current")
  assert.equal(recognizeQuestion("Which airport did I use before?", archive.field), "historical")
  assert.equal(recognizeQuestion("What is my current address?", archive.field), null)
  assert.equal(recognizeQuestion("Airport sounds exciting", archive.field), null)
})

function fakeProvider() {
  const writes: string[] = []
  let updated = false
  const transport: MemoryTransport = {
    async put(_namespace, doc) {
      writes.push(doc.id)
      return { id: doc.id, status: "queued" }
    },
    async read(request) {
      const text = request.stage === "history" ? ["Previously Oakland", "Current San Jose"]
        : updated ? ["San Jose"] : ["Oakland"]
      return { text, raw: {} }
    },
  }
  return { writes, transport, completeCorrection: () => { updated = true } }
}

test("a live session suppresses the old value while the provider processes the correction", async () => {
  const { transport, writes, completeCorrection } = fakeProvider()
  const service = liveVoiceSessions(archive.trial, transport, { openingProbes: [0] })
  const signal = new AbortController().signal
  const { callId, baseline } = await service.open(signal)
  assert.equal(baseline.value, "Oakland")
  await service.correct(callId, signal)
  await service.correct(callId, signal)
  assert.deepEqual(writes, ["baseline", "correction"])
  assert.equal((await service.lookup(callId, "current", signal)).value, null)
  completeCorrection()
  assert.equal((await service.lookup(callId, "current", signal)).value, "San Jose")
  assert.equal((await service.lookup(callId, "historical", signal)).value, "Oakland")
  service.close(callId)
  await assert.rejects(service.lookup(callId, "current", signal), /no longer open/)
})

test("live read budget applies to both the startup probes and in-call reads", async () => {
  const service = liveVoiceSessions(archive.trial, fakeProvider().transport, { openingProbes: [0], readLimit: 2 })
  const signal = new AbortController().signal
  const { callId, baseline } = await service.open(signal)
  assert.equal(baseline.remainingReads, 1)
  assert.equal((await service.lookup(callId, "current", signal)).remainingReads, 0)
  await assert.rejects(service.lookup(callId, "current", signal), /read budget/)
})

test("interrupting a turn propagates cancellation to the Supermemory request", async () => {
  const controller = new AbortController()
  const http: typeof fetch = async (_url, init) => {
    assert.ok(init?.signal)
    const delivered = init.signal
    const pending = new Promise<Response>((_, reject) => {
      const stopped = () => reject(delivered.reason)
      delivered.addEventListener("abort", stopped, { once: true })
    })
    controller.abort(new Error("interrupted at caller"))
    return pending
  }
  const memory = createSupermemory("test-token", 10, 1000, http)
  await assert.rejects(memory.read({
    namespace: "voice-test", surface: "profile", query: "", trial: archive.trial,
    mode: "instant", stage: "update", scheduledMs: 0, signal: controller.signal,
  }), /interrupted at caller/)
})
