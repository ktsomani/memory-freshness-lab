import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { errorMessage } from "./capture.ts"
import { exactAnswer, expectedAnswer } from "./protocol.ts"
import type { Observation, Trial } from "./protocol.ts"
import { readRun } from "./report.ts"
import { askOpenAI, isTerminalHttpError } from "./transport.ts"

export function diagnose(row: Observation, trial: Trial, response: string): string {
  const expected = expectedAnswer(trial, row.stage)
  if (exactAnswer(response, expected)) return "correct-exact"
  const expectedState = expected === trial.fact.old ? "old-only" : "new-only"
  const competingState = expectedState === "old-only" ? "new-only" : "old-only"
  if (row.evidence === "both") return "incorrect-with-mixed-evidence"
  if (row.evidence === expectedState) return "incorrect-despite-expected-evidence"
  if (row.evidence === competingState) return "incorrect-with-competing-evidence"
  return "incorrect-without-recognized-evidence"
}

export function selectReplayRows(directory: string, trialId?: string) {
  const { plan, rows } = readRun(directory)
  if (trialId && !plan.trials.some((trial) => trial.id === trialId))
    throw new Error(`Unknown trial: ${trialId}`)
  const horizon = plan.checkpointsMs.at(-1)
  const selected = rows.filter(
    (row): row is Observation =>
      row.type === "probe" &&
      (!trialId || row.trialId === trialId) &&
      row.evidence !== "error" &&
      ((row.stage === "history" && row.scheduledMs === 0) ||
        ((row.stage === "update" || row.stage === "late") && row.scheduledMs === horizon)),
  )
  return { plan, selected }
}

export async function replayAnswers(options: {
  directory: string
  key: string
  model: string
  trialId?: string
  maxCalls: number
  timeoutMs: number
}) {
  const { directory, key, model, trialId, maxCalls, timeoutMs } = options
  const { plan, selected } = selectReplayRows(directory, trialId)
  if (plan.mode !== "live") throw new Error("Model replay requires a live Supermemory capture.")
  if (!selected.length) throw new Error("No eligible final checkpoint captures to replay.")
  if (selected.length > maxCalls) {
    throw new Error(
      `Replay needs ${selected.length} model calls. Use --trial to narrow it, or set --max-calls explicitly.`,
    )
  }
  const lookup = new Map(plan.trials.map((trial) => [trial.id, trial]))
  const run = join(directory, `answers-${model}-${trialId ?? "all"}.ndjson`)
  if (existsSync(run))
    throw new Error(`Replay already exists at ${run}. Choose a different model or run directory.`)
  writeFileSync(run, "", { flag: "wx" })
  const counts: Record<string, number> = {}
  for (const row of selected) {
    const trial = lookup.get(row.trialId)!
    const base = {
      trialId: row.trialId,
      mode: row.mode,
      stage: row.stage,
      surface: row.surface,
      scheduledMs: row.scheduledMs,
      capturedAt: row.at,
      model,
      expected: expectedAnswer(trial, row.stage),
      query: row.query,
      evidence: row.evidence,
      context: row.text,
    }
    let outcome: string
    let details: Record<string, unknown>
    let stop = false
    try {
      const result = await askOpenAI(key, model, row.query, row.text, timeoutMs)
      outcome = diagnose(row, trial, result.answer)
      details = result
    } catch (error) {
      outcome = "model-error"
      details = { error: errorMessage(error) }
      stop = isTerminalHttpError(error)
    }
    appendFileSync(run, JSON.stringify({ ...base, outcome, ...details }) + "\n")
    counts[outcome] = (counts[outcome] ?? 0) + 1
    if (stop) break
  }
  return {
    run,
    selected: selected.length,
    attempted: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
  }
}
