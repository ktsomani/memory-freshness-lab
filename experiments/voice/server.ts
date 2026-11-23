import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { loadFixture } from "./fixture.ts"
import { createSupermemory } from "../../src/transport.ts"
import { liveVoiceSessions, VoiceError, READ_LIMIT } from "./live.ts"

const { values } = parseArgs({
  options: { capture: { type: "string" }, fact: { type: "string" }, port: { type: "string" }, live: { type: "boolean" } },
})
const capture = values.capture ?? fileURLToPath(new URL("../../results/four-fact-holdout", import.meta.url))
const { trial, ...fixture } = loadFixture(capture, values.fact ?? "airport")
const port = Number(values.port ?? 4179)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.")
const key = process.env.SUPERMEMORY_API_KEY
if (values.live && !key) throw new Error("SUPERMEMORY_API_KEY is required for live mode.")
const sessions = values.live ? liveVoiceSessions(trial, createSupermemory(key!, 10, 10000)) : undefined
const origin = `http://127.0.0.1:${port}`

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/call.js", ["call.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
])
createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  const json = (status: number, data: unknown) => {
    if (response.destroyed) return
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify(data))
  }
  if (path.startsWith("/api/")) {
    if (!sessions) return json(404, { error: "The server is running in replay mode." })
    if (request.headers.origin !== origin || request.headers.host !== `127.0.0.1:${port}`) {
      return json(403, { error: "Open live calls from the local demo URL." })
    }
    const controller = new AbortController()
    response.once("close", () => {
      if (!response.writableEnded) controller.abort()
    })
    try {
      if (path === "/api/calls" && request.method === "POST") {
        return json(201, await sessions.open(controller.signal))
      }
      const call = path.match(/^\/api\/calls\/([0-9a-f-]{36})(?:\/(correction|current|historical))?$/)
      if (!call) return json(404, { error: "Unknown call endpoint." })
      const [, id, action] = call
      if (!action && request.method === "DELETE") {
        sessions.close(id)
        return json(200, { closed: true })
      }
      if (request.method !== "POST") return json(405, { error: "Unsupported call operation." })
      if (action === "correction") return json(200, await sessions.correct(id, controller.signal))
      if (action === "current" || action === "historical") {
        return json(200, await sessions.lookup(id, action, controller.signal))
      }
      return json(404, { error: "Unknown call operation." })
    } catch (error) {
      return error instanceof VoiceError ? json(error.status, { error: error.message })
        : json(502, { error: "The Supermemory request failed. Check the API key and account limits." })
    }
  }
  if (request.method !== "GET") {
    response.writeHead(405).end()
    return
  }
  if (path === "/fixture.json") {
    const mode = sessions ? "live" : "replay"
    return json(200, { ...fixture, mode, readLimit: READ_LIMIT })
  }
  const file = files.get(path)
  if (!file) {
    response.writeHead(404).end()
    return
  }
  const [filename, type] = file
  response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" })
    .end(readFileSync(new URL(filename, import.meta.url)))
}).listen(port, "127.0.0.1", () => {
  console.log(`Voice memory demo (${sessions ? "live Supermemory" : "saved replay"}): ${origin}`)
})
