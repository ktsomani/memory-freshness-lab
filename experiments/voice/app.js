import { VoiceCall, LOOKUP_BUDGET_MS, createArchivedLookup, recognizeQuestion } from "./call.js"

const $ = (id) => document.getElementById(id)
const controls = ["change", "current", "history", "slow", "end"]
const list = $("events")
let fixture, calls, trace = [], callStarted = 0, generation = 0, pending = false
let callId, operation, listening, recognition
const answers = new Map()
const synthesis = window.speechSynthesis
const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
const localSpeechSupported = Boolean(SpeechRecognition?.available && "processLocally" in SpeechRecognition.prototype)
const statuses = {
  "call-start": "Call opened",
  "correction": "Correction received from a separate channel",
  "speech-finalized": "Question received",
  "lookup-start": "Lookup started",
  "lookup-ended": "Lookup finished",
  "answer-ready": "Answer ready",
  "turn-interrupted": "Turn interrupted",
  "call-ended": "Call ended",
  "playback-start": "Local audio started",
  "speech-unavailable": "Local English speech synthesis unavailable",
  "playback-error": "Local speech playback failed",
  "recognized-question": "Microphone question recognized",
}
const outcomes = {
  "call-start-profile": "Call-start snapshot",
  "turn-lookup": "Turn lookup",
  deadline: "Lookup timed out",
  unverified: "Evidence unavailable",
  "lookup-error": "Lookup failed",
}
const laneNames = { frozen: "Call-start profile", fresh: "Per-turn lookup" }

function record(lane, event) {
  const elapsedMs = Math.round(event.atMs - callStarted)
  const entry = { lane, elapsedMs, ...event }
  trace.push(entry)
  const item = document.createElement("li")
  const detail = event.value ?? outcomes[event.outcome] ?? event.question ?? event.reason
  item.textContent = `+${elapsedMs}ms · ${laneNames[lane]} · ${statuses[event.type]}${detail ? ` · ${detail}` : ""}`
  list.prepend(item)
  $("export").disabled = false
}

function update() {
  $("start").disabled = !fixture || Boolean(calls) || Boolean(operation)
  controls.forEach((id) => { $(id).disabled = !calls || Boolean(operation) })
  $("change").disabled ||= calls?.fresh.changed ?? false
  $("history").disabled ||= !calls?.fresh.changed
  $("slow").disabled ||= !calls?.fresh.changed
  $("microphone").disabled = !calls || Boolean(operation) || Boolean(listening)
  $("interrupt").disabled = !calls || (!pending && !listening && !synthesis?.speaking)
  $("dot").classList.toggle("active", Boolean(calls))
  if (fixture) {
    $("status").textContent = operation ?? (calls ? calls.fresh.changed ? "Call open · correction received" : "Call open" : "Call ready")
    $("scope").textContent = `${fixture.mode === "live" ? "Live Supermemory" : "Saved replay"} · ${fixture.name} · ${fixture.field} · ${LOOKUP_BUDGET_MS} ms lookup budget`
  }
}

async function request(path, { method = "POST", signal } = {}) {
  const response = await fetch(path, { method, signal })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error ?? "The call request failed.")
  return payload
}

function liveLookup(id) {
  return ({ question, slow, signal }) => {
    if (!slow) return request(`/api/calls/${id}/${question}`, { signal })
    return new Promise((_, reject) => {
      const abort = () => reject(new Error("Simulated slow lookup canceled."))
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })
  }
}

function notice(text = "") {
  $("notice").textContent = text
}

function show(lane, result) {
  $(lane).textContent = result?.spoken ?? "Turn interrupted"
  $(`${lane}-timing`).textContent = result
    ? `${outcomes[result.outcome] ?? result.outcome} · ${Math.round(result.decisionMs)} ms to answer ready` : ""
  const details = $(`${lane}-source`)
  const items = details.querySelector("ul")
  items.replaceChildren()
  for (const text of result?.evidence?.evidence ?? []) {
    const item = document.createElement("li")
    item.textContent = text
    items.append(item)
  }
  details.hidden = items.children.length === 0
  if (result) answers.set(lane, result)
  else answers.delete(lane)
  $(`play-${lane}`).disabled = !result
}

function speak(lane, automatic = false) {
  const answer = answers.get(lane)
  if (!answer) return
  synthesis?.cancel()
  const voice = synthesis?.getVoices().find((voice) => voice.localService && /^en\b/i.test(voice.lang))
  if (!voice) {
    record(lane, { type: "speech-unavailable", atMs: performance.now(), id: answer.id })
    update()
    return
  }
  const spoken = new SpeechSynthesisUtterance(answer.spoken)
  spoken.voice = voice
  const epoch = generation
  spoken.onstart = () => {
    if (generation !== epoch) return
    record(lane, { type: "playback-start", atMs: performance.now(), id: answer.id, automatic })
    update()
  }
  spoken.onerror = (event) => {
    if (generation === epoch && !["canceled", "interrupted"].includes(event.error))
      record(lane, { type: "playback-error", atMs: performance.now(), id: answer.id })
    update()
  }
  spoken.onend = update
  synthesis.speak(spoken)
  update()
}

function invalidate() {
  ++generation
  pending = false
  synthesis?.cancel()
  recognition?.abort?.()
  for (const lane of Object.keys(laneNames)) {
    answers.delete(lane)
    $(`play-${lane}`).disabled = true
  }
}

async function ask(question, slow = false) {
  if (!calls || operation) return
  invalidate()
  const epoch = generation
  pending = true
  for (const lane of Object.keys(laneNames)) {
    $(lane).textContent = "Checking…"
    $(`${lane}-timing`).textContent = ""
    $(`${lane}-source`).hidden = true
  }
  update()
  const activeCalls = calls
  await Promise.all(Object.keys(laneNames).map(async (lane) => {
    const result = await activeCalls[lane].ask(question, { slow })
    if (generation !== epoch) return
    show(lane, result)
    if (result && lane === "fresh") speak(lane, true)
  }))
  if (generation === epoch) {
    pending = false
    update()
  }
}

$("start").onclick = async () => {
  if (calls || operation) return
  operation = "Opening call…"
  notice(fixture.mode === "live" ? "Waiting for the initial Supermemory profile to become readable." : "")
  update()
  trace = []
  list.replaceChildren()
  try {
    const boot = fixture.mode === "live" ? await request("/api/calls") : undefined
    callId = boot?.callId
    const effectiveFixture = boot ? { ...fixture, before: boot.baseline } : fixture
    const lookup = boot ? liveLookup(boot.callId) : createArchivedLookup(fixture)
    callStarted = performance.now()
    calls = Object.fromEntries(Object.keys(laneNames).map((lane) => [lane, new VoiceCall({
      fixture: effectiveFixture, policy: lane === "frozen" ? "frozen" : "turn-lookup",
      lookup, emit: (event) => record(lane, event),
    })]))
    for (const lane of Object.keys(laneNames)) {
      show(lane, null)
      $(lane).textContent = "Waiting for a question"
    }
    notice(localSpeechSupported ? "Ask by voice or use the question buttons." : "")
  } catch (error) {
    notice(error.message)
  } finally {
    operation = undefined
    update()
  }
}
$("change").onclick = async () => {
  if (!calls || operation) return
  const wasPending = pending
  invalidate()
  if (wasPending) for (const lane of Object.keys(laneNames)) show(lane, null)
  operation = "Sending correction…"
  update()
  try {
    if (callId) await request(`/api/calls/${callId}/correction`)
    for (const call of Object.values(calls)) call.correct()
    notice(callId ? "Supermemory accepted the correction. The profile may still be processing." : "")
  } catch (error) {
    notice(error.message)
  } finally {
    operation = undefined
    update()
  }
}
$("current").onclick = () => void ask("current")
$("history").onclick = () => void ask("historical")
$("slow").onclick = () => void ask("current", true)
$("interrupt").onclick = () => {
  invalidate()
  for (const [lane, call] of Object.entries(calls)) {
    call.interrupt()
    show(lane, null)
  }
  update()
}
$("end").onclick = async () => {
  if (!calls || operation) return
  invalidate()
  for (const call of Object.values(calls)) call.close()
  calls = undefined
  const closedId = callId
  callId = undefined
  notice()
  if (closedId) {
    operation = "Ending call…"
    update()
    try { await request(`/api/calls/${closedId}`, { method: "DELETE" }) }
    catch (error) { notice(error.message) }
    finally { operation = undefined }
  }
  update()
}
$("play-frozen").onclick = () => speak("frozen")
$("play-fresh").onclick = () => speak("fresh")
$("microphone").onclick = async () => {
  if (!calls || operation || listening) return
  if (!localSpeechSupported) {
    notice("On-device speech recognition is unavailable in this browser. Use the question buttons.")
    return
  }
  invalidate()
  const epoch = generation
  listening = true
  update()
  try {
    const available = await SpeechRecognition.available({ langs: ["en-US"], processLocally: true })
    if (epoch !== generation) return
    if (available !== "available") {
      listening = false
      notice("An on-device English recognition pack is unavailable. Use the question buttons.")
      return
    }
    recognition = new SpeechRecognition()
    recognition.lang = "en-US"
    recognition.processLocally = true
    recognition.interimResults = false
    const active = recognition
    active.onresult = (event) => {
      if (epoch !== generation) return
      const text = event.results[0][0].transcript
      const question = recognizeQuestion(text, fixture.field)
      if (!question || (question === "historical" && !calls.fresh.changed)) {
        notice(`Try “What is my current ${fixture.field}?”`)
        return
      }
      record("fresh", { type: "recognized-question", atMs: performance.now(), question })
      notice(`Heard: ${text}`)
      void ask(question)
    }
    active.onerror = () => {
      if (epoch === generation) notice("Local microphone recognition failed. Use the question buttons.")
    }
    active.onend = () => {
      if (recognition !== active) return
      recognition = undefined
      listening = false
      update()
    }
    notice("Listening for a current or previous value question…")
    active.start()
  } catch {
    listening = false
    notice("Could not start on-device recognition. Use the question buttons.")
  } finally {
    if (epoch !== generation && !recognition) listening = false
    update()
  }
}
$("export").onclick = () => {
  const exportData = { version: 1, mode: fixture.mode, scenario: fixture.id, trace }
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = "voice-memory-trace.json"
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

try {
  const response = await fetch("/fixture.json")
  if (!response.ok) throw new Error("Could not load the saved case.")
  fixture = await response.json()
  $("mode-note").textContent = fixture.mode === "live"
    ? `Live synthetic call using the Supermemory API. Up to two writes and ${fixture.readLimit} reads per call. Speech synthesis runs locally when available.`
    : "Scripted replay of saved Supermemory evidence. Audio uses the browser’s local speech synthesis when available."
  synthesis?.getVoices()
  update()
} catch (error) {
  $("status").textContent = "Replay unavailable"
  $("scope").textContent = error.message
}
