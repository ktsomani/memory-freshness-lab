import { appendFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { classifyEvidence, documentsFor, MODES, question, SURFACES } from "./protocol.ts"
import type {
  Event,
  Mode,
  Observation,
  RecordRow,
  RunPlan,
  Stage,
  Surface,
  Trial,
} from "./protocol.ts"
import type { MemoryTransport } from "./transport.ts"
import { isTerminalHttpError } from "./transport.ts"

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export function requestBounds(plan: RunPlan) {
  const baselineReads = plan.baselineMs.length * SURFACES.length
  const stageReads = plan.checkpointsMs.length * SURFACES.length
  const perArm = plan.trials.map(({ variant }) => ({
    writes: variant === "late-import" ? 3 : 2,
    reads:
      baselineReads +
      stageReads +
      (variant === "late-import" ? stageReads : 0) +
      (variant === "unrelated-control" ? 0 : SURFACES.length),
  }))
  return perArm.reduce(
    (sum, trial) => ({
      writes: sum.writes + MODES.length * trial.writes,
      reads: sum.reads + MODES.length * trial.reads,
    }),
    { writes: 0, reads: 0 },
  )
}

export async function captureRun(
  plan: RunPlan,
  transport: MemoryTransport,
  journal: string,
): Promise<void> {
  const write = (record: RecordRow) =>
    appendFileSync(journal, JSON.stringify(record) + "\n", "utf8")
  const event = (entry: Omit<Event, "at">) => write({ ...entry, at: new Date().toISOString() })
  const live = plan.mode === "live"
  const stop = new AbortController()
  function stopOnTerminal(error: unknown) {
    if (isTerminalHttpError(error) && !stop.signal.aborted) stop.abort(error)
  }
  async function arm(trial: Trial, mode: Mode) {
    const trialId = trial.id
    const namespace = `mfl-${plan.runId}-${trialId}-${mode}`
    const identifying = { trialId, mode, namespace }
    const documents = documentsFor(trial, plan.background?.content)
    const eligibility = new Map<Surface, boolean>()

    async function ingest(key: keyof typeof documents, stage: Stage) {
      stop.signal.throwIfAborted()
      const documentId = `${trialId}-${key}`
      const start = performance.now()
      const raw = await transport.put(namespace, {
        id: documentId,
        ...documents[key],
        dreaming: key === "seed" ? "instant" : mode,
      })
      const elapsed = Math.round(performance.now() - start)
      event({ type: "write", ...identifying, stage, documentId, raw, latencyMs: elapsed })
    }

    async function probe(
      stage: Stage,
      origin: number,
      scheduledMs: number,
    ): Promise<Observation[]> {
      stop.signal.throwIfAborted()
      const remaining = scheduledMs - (performance.now() - origin)
      if (live && remaining > 0) await delay(remaining, undefined, { signal: stop.signal })
      const query = question(trial.fact, stage)
      return Promise.all(
        SURFACES.map(async (surface) => {
          const start = performance.now()
          const base = {
            type: "probe" as const,
            at: new Date().toISOString(),
            ...identifying,
            variant: trial.variant,
            stage,
            surface,
            query,
            scheduledMs,
            ...(stage !== "baseline" && { baselineEligible: eligibility.get(surface) ?? false }),
          }
          let result: Observation
          try {
            const { raw, text } = await transport.read({
              namespace,
              surface,
              query,
              trial,
              mode,
              stage,
              scheduledMs,
            })
            result = {
              ...base,
              raw,
              text,
              evidence: classifyEvidence(text, trial.fact),
              observedMs: live ? Math.round(performance.now() - origin) : scheduledMs,
              latencyMs: Math.round(performance.now() - start),
            }
          } catch (error) {
            stopOnTerminal(error)
            result = {
              ...base,
              text: [],
              evidence: "error",
              error: errorMessage(error),
              observedMs: live ? Math.round(performance.now() - origin) : scheduledMs,
              latencyMs: Math.round(performance.now() - start),
            }
          }
          write(result)
          return result
        }),
      )
    }

    try {
      await ingest("seed", "baseline")
      const baselineStart = performance.now()
      for (const offset of plan.baselineMs) {
        const rows = await probe("baseline", baselineStart, offset)
        for (const row of rows) eligibility.set(row.surface, row.evidence === "old-only")
        if ([...eligibility.values()].every(Boolean)) break
      }
      await ingest("update", "update")
      const updateStart = performance.now()
      for (const offset of plan.checkpointsMs) await probe("update", updateStart, offset)
      if (trial.variant === "late-import") {
        await ingest("late", "late")
        const lateStart = performance.now()
        for (const offset of plan.checkpointsMs) await probe("late", lateStart, offset)
      }
      if (trial.variant !== "unrelated-control") await probe("history", performance.now(), 0)
      stop.signal.throwIfAborted()
      event({ type: "trial-end", ...identifying })
    } catch (error) {
      stopOnTerminal(error)
      event({
        type: "trial-error",
        ...identifying,
        error: errorMessage(stop.signal.reason ?? error),
      })
    }
  }

  let cursor = 0
  async function worker() {
    while (cursor < plan.trials.length && !stop.signal.aborted) {
      const index = cursor++
      const trial = plan.trials[index]
      const order = index % 2 === 0 ? MODES : [...MODES].reverse()
      await Promise.all(order.map((mode) => arm(trial, mode)))
    }
  }
  await Promise.all(Array.from({ length: Math.min(plan.concurrency, plan.trials.length) }, worker))
  if (stop.signal.aborted) event({ type: "run-aborted", error: errorMessage(stop.signal.reason) })
  else event({ type: "run-end" })
}
