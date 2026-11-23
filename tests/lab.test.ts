import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { diagnose } from "../src/answer.ts"
import { captureRun } from "../src/capture.ts"
import { classifyEvidence, documentsFor, trialsFor } from "../src/protocol.ts"
import type { Fact, Observation } from "../src/protocol.ts"
import { readJournal, readRun, summarize, writeReport } from "../src/report.ts"
import { askOpenAI, createSupermemory } from "../src/transport.ts"

const fixture = JSON.parse(
  readFileSync(new URL("../datasets/facts-v1.json", import.meta.url), "utf8"),
) as Fact[]
const trial = trialsFor(fixture)[1]
const cli = new URL("../src/cli.ts", import.meta.url)

test("evidence matching uses word boundaries and distinguishes conflicting context", () => {
  assert.equal(classifyEvidence(["Bostonian coworkers", "SEATTLE!"], trial.fact), "new-only")
  assert.equal(classifyEvidence(["Moved from Boston to Seattle"], trial.fact), "both")
  assert.equal(classifyEvidence(["Boston"], trial.fact), "old-only")
  assert.equal(classifyEvidence(["The address is unknown."], trial.fact), "neither")
  assert.ok(documentsFor(trial).late.date < documentsFor(trial).update.date)
})

test("answer scoring separates conflicting context from misses with expected evidence", () => {
  const row = { stage: "update", evidence: "both" } as Observation
  assert.equal(diagnose(row, trial, "Seattle."), "correct-exact")
  assert.equal(diagnose(row, trial, "Boston"), "incorrect-with-mixed-evidence")
  assert.equal(
    diagnose({ ...row, evidence: "new-only" }, trial, "Boston"),
    "incorrect-despite-expected-evidence",
  )
  assert.equal(
    diagnose({ ...row, evidence: "old-only" }, trial, "Boston"),
    "incorrect-with-competing-evidence",
  )
  assert.equal(diagnose({ ...row, stage: "history" }, trial, "Boston"), "correct-exact")
})

test("live transport follows the v5 namespace paths and preserves raw evidence", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token")
    assert.equal(init?.method, "POST")
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    if (url.endsWith("/document")) return Response.json({ id: "doc", status: "queued" })
    if (url.endsWith("/profile"))
      return Response.json({
        profile: {
          static: [{ memory: "Boston" }],
          dynamic: [{ memory: "Seattle" }],
          buckets: { travel: [{ memory: "Seattle" }, { memory: "Bikes" }] },
        },
      })
    return Response.json({ results: [{ memory: "Seattle" }, { chunk: "A prior note: Boston" }] })
  }
  const service = createSupermemory("test-token", 8, 1000, fakeFetch)
  const document = {
    id: "doc",
    content: "Current address: Seattle",
    date: "2024-02-05T12:00:00.000Z",
    dreaming: "instant" as const,
  }
  await service.put("run:example", document)
  const read = {
    namespace: "run:example",
    surface: "profile",
    query: "shipping city",
    trial,
    mode: "instant",
    stage: "update",
    scheduledMs: 0,
  } as const
  assert.deepEqual((await service.read(read)).text, ["Boston", "Seattle", "Bikes"])
  const hybrid = await service.read({ ...read, surface: "hybrid" })
  assert.deepEqual(hybrid.text, ["Seattle", "A prior note: Boston"])
  assert.deepEqual(requests, [
    { url: "https://api.supermemory.ai/ns/run%3Aexample/document", body: document },
    { url: "https://api.supermemory.ai/ns/run%3Aexample/profile", body: {} },
    {
      url: "https://api.supermemory.ai/ns/run%3Aexample/search",
      body: { query: "shipping city", searchMode: "hybrid", limit: 8 },
    },
  ])
})

test("API errors remain failures and OpenAI replay sends saved context with a bounded output", async () => {
  const denied: typeof fetch = async () => new Response("invalid key", { status: 401 })
  const service = createSupermemory("test-token", 8, 1000, denied)
  await assert.rejects(
    service.read({
      namespace: "test",
      surface: "profile",
      query: "",
      trial,
      mode: "instant",
      stage: "update",
      scheduledMs: 0,
    }),
    /HTTP 401/,
  )
  const fakeModel: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses")
    const body = JSON.parse(String(init?.body))
    assert.equal(body.max_output_tokens, 128)
    assert.deepEqual(JSON.parse(body.input), { question: "City?", evidence: ["Seattle"] })
    return Response.json({
      output: [{ type: "message", content: [{ type: "output_text", text: "Seattle" }] }],
    })
  }
  assert.equal(
    (await askOpenAI("test-token", "test-model", "City?", ["Seattle"], 1000, fakeModel)).answer,
    "Seattle",
  )
})

function cliRun(args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      fileURLToPath(cli),
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, SUPERMEMORY_API_KEY: "", OPENAI_API_KEY: "" } },
  )
}

test("fact selection holds out the pilot and keeps each selected fact group intact", () => {
  const plan = cliRun(["plan", "--facts", "drink,timezone,editor,airport"])
  assert.equal(plan.status, 0, plan.stderr)
  const counts = JSON.parse(plan.stdout)
  assert.equal(counts.trials, 12)
  assert.equal(counts.writes, 56)
  assert.equal(counts.reads, 704)
  assert.equal(cliRun(["plan", "--facts", "drink,drink"]).status, 1)
  assert.equal(cliRun(["plan", "--facts", "missing"]).status, 1)
  assert.equal(cliRun(["plan", "--facts", "drink", "--limit", "1"]).status, 1)
})

test("CLI produces a reproducible 36-scenario report, paired counts and incomplete-run diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "freshness-lab-"))
  try {
    const output = join(root, "run")
    const run = cliRun(["demo", "--out", output])
    assert.equal(run.status, 0, run.stderr)
    const { plan, rows } = readRun(output)
    assert.equal(plan.trials.length, 36)
    assert.equal(new Set(rows.flatMap((row) => row.namespace ?? [])).size, 72)
    const result = writeReport(output)
    assert.equal(result.completedArms, 72)
    assert.equal(result.probeErrors, 0)
    assert.equal(
      result.paired.find((row) => row.surface === "hybrid" && row.scheduledMs === 5000)
        ?.instantOnly,
      24,
    )
    assert.equal(
      result.strata.find((row) => row.mode === "dynamic" && row.surface === "profile")?.lateBoth,
      12,
    )
    assert.match(readFileSync(join(output, "report.md"), "utf8"), /Synthetic workflow validation/)
    const withoutFinish = rows.filter((row) => row.type !== "run-end")
    assert.equal(summarize(plan, withoutFinish).complete, false)
    const incompletePath = join(root, "partial.ndjson")
    writeFileSync(incompletePath, JSON.stringify(rows[0]) + '\n{"type":')
    assert.equal(readJournal(incompletePath).length, 1)
    assert.equal(cliRun(["demo", "--out", output]).status, 1)
    assert.match(
      cliRun(["run", "--live", "--out", join(root, "live")]).stderr,
      /SUPERMEMORY_API_KEY/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a terminal credential or rate-limit failure stops before scheduling later scenario pairs", async () => {
  const root = mkdtempSync(join(tmpdir(), "freshness-capture-"))
  try {
    let requests = 0
    const throttled: typeof fetch = async () => {
      requests++
      return new Response(null, { status: 429 })
    }
    const service = createSupermemory("test-token", 8, 1000, throttled)
    const journal = join(root, "observations.ndjson")
    await captureRun(
      {
        version: 1,
        runId: "throttled",
        mode: "live",
        createdAt: "2026-01-01",
        datasetSha256: "fixture",
        trials: trialsFor(fixture).slice(0, 3),
        checkpointsMs: [0, 5000],
        baselineMs: [0, 5000],
        searchLimit: 8,
        concurrency: 1,
        requestTimeoutMs: 1000,
      },
      service,
      journal,
    )
    assert.equal(requests, 2)
    const entries = readJournal(journal)
    assert.equal(entries.filter((row) => row.type === "trial-error").length, 2)
    assert.equal(entries.at(-1)?.type, "run-aborted")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
