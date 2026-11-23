import { readRun } from "../../src/report.ts"
import type { Observation } from "../../src/protocol.ts"

export function loadFixture(directory: string, factId: string) {
  const { plan, rows } = readRun(directory)
  if (plan.mode !== "live") throw new Error("Use a saved live capture for the voice demo.")
  const trial = plan.trials.find((t) => t.variant === "correction" && t.fact.id === factId)
  if (!trial) throw new Error(`No standard correction for ${factId}.`)
  const entries = rows.filter((r): r is Observation =>
    r.type === "probe" && r.trialId === trial.id && r.mode === "instant" && r.evidence !== "error",
  )
  const horizon = plan.checkpointsMs.at(-1)
  const before = entries.findLast((r) =>
    r.stage === "baseline" && r.surface === "profile" && r.evidence === "old-only",
  )
  const after = entries.find((r) =>
    r.stage === "update" && r.surface === "profile" && r.scheduledMs === horizon,
  )
  const history = entries.find((r) => r.stage === "history" && r.surface === "hybrid")
  if (!before || !after || !history) throw new Error("The capture is missing a required observation.")
  const profileValue = (snapshot: Observation) =>
    snapshot.evidence === "new-only" ? trial.fact.next
      : snapshot.evidence === "old-only" ? trial.fact.old : null
  const beforeValue = profileValue(before)
  if (!beforeValue) throw new Error("The call needs a known pre-correction profile.")
  return {
    trial,
    id: trial.id,
    name: trial.fact.name,
    field: trial.fact.field,
    correction: trial.fact.next,
    before: {
      value: beforeValue, evidence: before.text, latencyMs: before.latencyMs, surface: "profile",
    },
    after: {
      value: profileValue(after), evidence: after.text, latencyMs: after.latencyMs, surface: "profile",
    },
    history: {
      value: history.evidence === "old-only" || history.evidence === "both" ? trial.fact.old : null,
      evidence: history.text, latencyMs: history.latencyMs, surface: "hybrid search",
    },
  }
}
