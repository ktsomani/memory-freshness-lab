import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { classifyEvidence, MODES, SURFACES } from "../src/protocol.ts"
import type { Fact, Mode, Observation, Surface } from "../src/protocol.ts"
import { readRun, summarize } from "../src/report.ts"

const directory = process.argv[2]
if (!directory) throw new Error("Pass a cohort run directory.")
const { plan, rows } = readRun(directory)
const scopes = summarize(plan, rows)
const corrections = plan.trials.filter(({ variant }) => variant === "correction")
const probes = rows.filter((row): row is Observation => row.type === "probe")
const eligible = (row: Observation | undefined): row is Observation =>
  Boolean(row?.baselineEligible && row.evidence !== "error")
const targetTimes = [30000, 120000]
if (targetTimes.some((time) => !plan.checkpointsMs.includes(time))) {
  throw new Error("The holdout report requires the planned 30s and 120s checkpoints.")
}

function pair(trialId: string, surface: Surface, scheduledMs: number) {
  return MODES.map((mode) =>
    probes.find(
      (row) =>
        row.trialId === trialId &&
        row.surface === surface &&
        row.mode === mode &&
        row.stage === "update" &&
        row.scheduledMs === scheduledMs,
    ),
  )
}

const countMatching = (rows: Observation[], mode: Mode, state: string) =>
  rows.filter((row) => row.mode === mode && row.evidence === state).length

function resultSources(row: Observation, fact: Fact) {
  const results =
    (row.raw as { results?: Array<{ memory?: unknown; chunk?: unknown }> })?.results ?? []
  const byType = (type: "memory" | "chunk") =>
    classifyEvidence(
      results.flatMap((item) => (typeof item?.[type] === "string" ? [item[type]] : [])),
      fact,
    )
  const memory = byType("memory")
  const chunk = byType("chunk")
  return { memory, chunk }
}

const outcomes = SURFACES.flatMap((surface) =>
  targetTimes.map((scheduledMs) => {
    const pairs = corrections
      .map((trial) => pair(trial.id, surface, scheduledMs))
      .filter((items) => items.every(eligible))
    const observations = pairs.flat()
    return {
      surface,
      scheduledMs,
      observedPairs: pairs.length,
      dynamicNewOnly: countMatching(observations, "dynamic", "new-only"),
      instantNewOnly: countMatching(observations, "instant", "new-only"),
      dynamicMixed: countMatching(observations, "dynamic", "both"),
      instantMixed: countMatching(observations, "instant", "both"),
    }
  }),
)

const finalSources = corrections.flatMap((trial) =>
  pair(trial.id, "hybrid", 120000)
    .filter(eligible)
    .map((row) => ({
      fact: trial.fact.id,
      mode: row.mode,
      evidence: row.evidence,
      ...resultSources(row, trial.fact),
    })),
)

const format = (row: Observation | undefined) =>
  eligible(row) ? `${row.evidence} (${(row.observedMs / 1000).toFixed(1)}s)` : "—"

const lines = [
  "# Four-fact Supermemory holdout",
  "",
  `**${plan.mode.toUpperCase()} · ${corrections.length} fact types · ${scopes.completedArms}/${scopes.plannedArms} arms completed · ${scopes.probeErrors} read errors**`,
  ...(!scopes.complete ? ["", "**Capture incomplete. A missing observation is not counted as an outcome.**"] : []),
  "",
  ...(plan.mode === "synthetic"
    ? ["Synthetic workflow example. This run does not measure Supermemory.", ""]
    : []),
  "## Standard corrections",
  "",
  "| Surface | Checkpoint | Comparable fact pairs | Dynamic new only | Instant new only | Dynamic mixed | Instant mixed |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...outcomes.map(
    (r) =>
      `| ${r.surface} | ${r.scheduledMs / 1000}s | ${r.observedPairs} | ${r.dynamicNewOnly} | ${r.instantNewOnly} | ${r.dynamicMixed} | ${r.instantMixed} |`,
  ),
  "",
  "### Profiles by fact",
  "",
  "| Fact | 30s dynamic | 30s instant | 120s dynamic | 120s instant |",
  "| --- | --- | --- | --- | --- |",
  ...corrections.map(
    (trial) =>
      `| ${trial.fact.field} | ${targetTimes
        .flatMap((time) => pair(trial.id, "profile", time))
        .map(format)
        .join(" | ")} |`,
  ),
  "",
  "### Hybrid source attribution at 120 seconds",
  "",
  "| Fact | Mode | Combined evidence | Extracted memories | Source chunks |",
  "| --- | --- | --- | --- | --- |",
  ...finalSources.map(
    (r) => `| ${r.fact} | ${r.mode} | ${r.evidence} | ${r.memory} | ${r.chunk} |`,
  ),
  "",
  "## Late imports and unchanged controls",
  "",
  "| Mode | Surface | Post-import observed / at risk | Saw old only | Saw mixed | Original value retained in controls |",
  "| --- | --- | ---: | ---: | ---: | ---: |",
  ...scopes.strata.map(
    (r) =>
      `| ${r.mode} | ${r.surface} | ${r.lateObserved}/${r.lateAtRisk} | ${r.lateOldOnly} | ${r.lateBoth} | ${r.controlsPreserved}/${r.controlsObserved} |`,
  ),
  "",
  "Late-import counts cover arms that had only the new value at the final checkpoint before import. Counts of zero among zero eligible arms carry no evidence about regression. Hybrid results can retain useful historical source chunks, so the mixed flag alone cannot identify correctness or freshness of the extracted memory.",
  "",
  "The primary denominator is independent fact types within this fixture set. The companion `report.md` covers all scenario variants, and `observations.ndjson` preserves the raw evidence. No answer model was evaluated in this capture.",
  "",
]
writeFileSync(join(directory, "holdout-findings.md"), lines.join("\n"))
writeFileSync(
  join(directory, "holdout-findings.json"),
  JSON.stringify({ outcomes, finalSources }, null, 2) + "\n",
)
console.log(`Wrote ${join(directory, "holdout-findings.md")}`)
