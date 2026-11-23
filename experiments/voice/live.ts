import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { classifyEvidence, documentsFor, question } from "../../src/protocol.ts"
import type { Stage, Trial } from "../../src/protocol.ts"
import type { MemoryTransport } from "../../src/transport.ts"

type Session = {
  namespace: string
  state: "opening" | "ready" | "posting" | "corrected" | "uncertain"
  reads: number
  touched: number
}

export class VoiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const OPENING_PROBES = [0, 5000, 15000, 30000, 60000]
export const READ_LIMIT = 32

export function liveVoiceSessions(
  trial: Trial,
  transport: MemoryTransport,
  options: { openingProbes?: number[]; readLimit?: number } = {},
) {
  const sessions = new Map<string, Session>()
  const docs = documentsFor(trial)
  const openingProbes = options.openingProbes ?? OPENING_PROBES
  const readLimit = options.readLimit ?? READ_LIMIT

  function get(callId: string) {
    const session = sessions.get(callId)
    if (!session || Date.now() - session.touched > 30 * 60 * 1000) {
      sessions.delete(callId)
      throw new VoiceError(404, "The call is no longer open.")
    }
    session.touched = Date.now()
    return session
  }

  async function read(session: Session, stage: Stage, signal: AbortSignal) {
    signal.throwIfAborted()
    if (session.reads >= readLimit) throw new VoiceError(429, "This call reached its read budget.")
    session.reads++
    const start = performance.now()
    const surface = stage === "history" ? "hybrid" : "profile"
    const { text } = await transport.read({
      namespace: session.namespace,
      surface, query: question(trial.fact, stage), trial, mode: "instant", stage,
      scheduledMs: 0, signal,
    })
    signal.throwIfAborted()
    const evidence = classifyEvidence(text, trial.fact)
    const value = stage === "history" && (evidence === "old-only" || evidence === "both") ? trial.fact.old
      : stage === "baseline" && evidence === "old-only" ? trial.fact.old
      : stage === "update" && evidence === "new-only" ? trial.fact.next : null
    return {
      value, evidence: text, evidenceState: evidence,
      latencyMs: Math.round(performance.now() - start),
      surface: surface === "hybrid" ? "hybrid search" : surface,
      remainingReads: readLimit - session.reads,
    }
  }

  return {
    async open(signal: AbortSignal) {
      for (const [id, session] of sessions) {
        if (Date.now() - session.touched > 30 * 60 * 1000) sessions.delete(id)
      }
      if (sessions.size >= 4) throw new VoiceError(429, "Close another call before opening a new one.")
      const callId = randomUUID()
      const session: Session = { namespace: `mfl-voice-${callId}`, state: "opening", reads: 0, touched: Date.now() }
      sessions.set(callId, session)
      try {
        await transport.put(session.namespace, { ...docs.seed, id: "baseline", dreaming: "instant" }, signal)
        const start = performance.now()
        for (const offset of openingProbes) {
          const remaining = offset - (performance.now() - start)
          if (remaining > 0) await delay(remaining, undefined, { signal })
          const baseline = await read(session, "baseline", signal)
          if (baseline.value !== null) {
            session.state = "ready"
            return { callId, baseline }
          }
        }
        throw new VoiceError(504, "The opening profile is still indexing. A new call can be started later.")
      } catch (error) {
        sessions.delete(callId)
        throw error
      }
    },
    async correct(callId: string, signal: AbortSignal) {
      const session = get(callId)
      if (session.state === "corrected") return { accepted: true }
      if (session.state !== "ready") throw new VoiceError(409, "This correction is already in progress or its outcome is uncertain.")
      session.state = "posting"
      try {
        await transport.put(session.namespace, { ...docs.update, id: "correction", dreaming: "instant" }, signal)
        signal.throwIfAborted()
      } catch (error) {
        session.state = "uncertain"
        throw error
      }
      session.state = "corrected"
      return { accepted: true }
    },
    async lookup(callId: string, kind: "current" | "historical", signal: AbortSignal) {
      const session = get(callId)
      if (session.state !== "ready" && session.state !== "corrected") {
        throw new VoiceError(409, "The memory revision is not ready to be read.")
      }
      if (kind === "historical" && session.state !== "corrected") {
        throw new VoiceError(409, "No correction has been recorded for this call.")
      }
      const stage = kind === "historical" ? "history" : session.state === "corrected" ? "update" : "baseline"
      const result = await read(session, stage, signal)
      if (sessions.get(callId) !== session) throw new VoiceError(404, "The call has ended.")
      const stableStage = kind === "historical" ? session.state === "corrected"
        : session.state === (stage === "update" ? "corrected" : "ready")
      if (!stableStage) return { ...result, value: null }
      return result
    },
    close(callId: string) {
      sessions.delete(callId)
    },
  }
}
