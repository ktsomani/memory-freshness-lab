import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MODES, SURFACES } from "./protocol.ts"
import type { Evidence, Observation, RecordRow, RunPlan } from "./protocol.ts"

export function readJournal(path: string): RecordRow[] {
  const data = readFileSync(path, "utf8")
  const lines = data.split("\n")
  // Only complete lines are committed. A killed process may leave one partial line.
  lines.pop()
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as RecordRow
    } catch {
      throw new Error(`Invalid journal entry on line ${index + 1}`)
    }
  })
}

export function readRun(directory: string) {
  const plan = JSON.parse(readFileSync(join(directory, "run.json"), "utf8")) as RunPlan
  if (plan.version !== 1 || !Array.isArray(plan.trials) || !plan.checkpointsMs.length)
    throw new Error("Unsupported run manifest")
  return { plan, rows: readJournal(join(directory, "observations.ndjson")) }
}

function quantify(values: number[], percentile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * percentile) - 1]
}

function indexOf(rows: Observation[]) {
  const key = (row: Pick<Observation, "trialId" | "mode" | "surface" | "stage" | "scheduledMs">) =>
    [row.trialId, row.mode, row.surface, row.stage, row.scheduledMs].join(":")
  const values = new Map(rows.map((row) => [key(row), row]))
  return (row: Parameters<typeof key>[0]) => values.get(key(row))
}

export function summarize(plan: RunPlan, rows: RecordRow[]) {
  const probes = rows.filter((row): row is Observation => row.type === "probe")
  const get = indexOf(probes)
  const horizon = plan.checkpointsMs.at(-1)!
  const mutations = plan.trials.filter((trial) => trial.variant !== "unrelated-control")

  const strata = SURFACES.flatMap((surface) =>
    MODES.map((mode) => {
      const outcomes = mutations.map((trial) =>
        plan.checkpointsMs.map((scheduledMs) =>
          get({ trialId: trial.id, mode, surface, stage: "update", scheduledMs }),
        ),
      )
      const eligible = outcomes.filter((series) => series.some((row) => row?.baselineEligible))
      const firstFresh = eligible.map((series) =>
        series.find((row) => row?.evidence === "new-only"),
      )
      const observationsWithFreshness = firstFresh.filter(
        (row): row is Observation => row !== undefined,
      )
      const neverObserved = eligible.length - observationsWithFreshness.length
      const censoredAtHorizon = eligible.filter(
        (series, index) =>
          !firstFresh[index] && series.every((row) => row && row.evidence !== "error"),
      ).length
      const final = eligible.map((series) => series.at(-1))
      const late = plan.trials
        .filter((trial) => trial.variant === "late-import")
        .flatMap((trial) => {
          const before = get({
            trialId: trial.id,
            mode,
            surface,
            stage: "update",
            scheduledMs: horizon,
          })
          if (before?.evidence !== "new-only" || !before.baselineEligible) return []
          return [
            plan.checkpointsMs.map((scheduledMs) =>
              get({ trialId: trial.id, mode, surface, stage: "late", scheduledMs }),
            ),
          ]
        })
      const lateObserved = late.filter((series) =>
        series.some((row) => row && row.evidence !== "error"),
      )
      const controls = plan.trials
        .filter((trial) => trial.variant === "unrelated-control")
        .map((trial) =>
          get({ trialId: trial.id, mode, surface, stage: "update", scheduledMs: horizon }),
        )
        .filter((row): row is Observation =>
          Boolean(row?.baselineEligible && row.evidence !== "error"),
        )
      const history = mutations
        .map((trial) => get({ trialId: trial.id, mode, surface, stage: "history", scheduledMs: 0 }))
        .filter((row): row is Observation => Boolean(row && row.evidence !== "error"))
      const latencies = probes
        .filter((row) => row.mode === mode && row.surface === surface && row.evidence !== "error")
        .map((row) => row.latencyMs)
      const finalStates = Object.fromEntries(
        (["old-only", "new-only", "both", "neither", "error", "missing"] as const).map((state) => [
          state,
          final.filter((row) => (row?.evidence ?? "missing") === state).length,
        ]),
      ) as Record<Evidence | "missing", number>
      return {
        mode,
        surface,
        plannedUpdates: mutations.length,
        eligibleUpdates: eligible.length,
        firstFreshObserved: observationsWithFreshness.length,
        censoredAtHorizon,
        incompleteWithoutFreshness: neverObserved - censoredAtHorizon,
        medianFirstObservationMs: quantify(
          observationsWithFreshness.map((row) => row.observedMs),
          0.5,
        ),
        finalStates,
        readP95Ms: quantify(latencies, 0.95),
        lateAtRisk: late.length,
        lateObserved: lateObserved.length,
        lateOldOnly: lateObserved.filter((series) =>
          series.some((row) => row?.evidence === "old-only"),
        ).length,
        lateBoth: lateObserved.filter((series) => series.some((row) => row?.evidence === "both"))
          .length,
        controlsObserved: controls.length,
        controlsPreserved: controls.filter((row) => row.evidence === "old-only").length,
        historyObserved: history.length,
        historyPriorValue: history.filter(
          (row) => row.evidence === "old-only" || row.evidence === "both",
        ).length,
      }
    }),
  )

  const paired = SURFACES.flatMap((surface) =>
    plan.checkpointsMs.map((scheduledMs) => {
      const getArm = (trialId: string, mode: (typeof MODES)[number]) =>
        get({ trialId, mode, surface, stage: "update", scheduledMs })
      let comparable = 0,
        instantOnly = 0,
        dynamicOnly = 0,
        bothFresh = 0
      for (const trial of mutations) {
        const dynamic = getArm(trial.id, "dynamic")
        const instant = getArm(trial.id, "instant")
        if (
          !dynamic?.baselineEligible ||
          !instant?.baselineEligible ||
          dynamic.evidence === "error" ||
          instant.evidence === "error"
        )
          continue
        comparable++
        const a = dynamic.evidence === "new-only",
          b = instant.evidence === "new-only"
        if (a && b) bothFresh++
        else if (a) dynamicOnly++
        else if (b) instantOnly++
      }
      return {
        surface,
        scheduledMs,
        comparable,
        instantOnly,
        dynamicOnly,
        bothFresh,
        neitherFresh: comparable - instantOnly - dynamicOnly - bothFresh,
        deltaPercentagePoints: comparable ? (100 * (instantOnly - dynamicOnly)) / comparable : null,
      }
    }),
  )
  return {
    runId: plan.runId,
    mode: plan.mode,
    complete: rows.some((row) => row.type === "run-end"),
    completedArms: rows.filter((row) => row.type === "trial-end").length,
    failedArms: rows.filter((row) => row.type === "trial-error").length,
    plannedArms: plan.trials.length * MODES.length,
    probeErrors: probes.filter((row) => row.evidence === "error").length,
    stopReason: rows.find((row) => row.type === "run-aborted")?.error ?? null,
    horizon,
    strata,
    paired,
  }
}

const show = (value: number | null) => (value === null ? "—" : String(Math.round(value * 10) / 10))
const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`

export function writeReport(directory: string) {
  const { plan, rows } = readRun(directory)
  const results = summarize(plan, rows)
  const drills = rows
    .filter((row): row is Observation => row.type === "probe")
    .filter(
      (row) => row.stage === "late" && (row.evidence === "both" || row.evidence === "old-only"),
    )
    .slice(0, 4)
  const markdown = [
    "# Memory freshness experiment",
    "",
    `**Run \`${plan.runId}\` · ${plan.mode.toUpperCase()} · ${results.complete ? "capture finished" : "capture incomplete"}**`,
    "",
    ...(plan.mode === "synthetic"
      ? ["**Synthetic workflow validation. These values do not measure Supermemory.**", ""]
      : []),
    `Finished arms ${results.completedArms}/${results.plannedArms}. Failed arms ${results.failedArms}. Read errors ${results.probeErrors}. Final update checkpoint ${results.horizon / 1000}s after write acknowledgement.`,
    ...(plan.background ? [`Background history SHA-256: \`${plan.background.sha256}\`.`] : []),
    "",
    "## Paired update outcomes",
    "",
    "| Surface | Target time (s) | Comparable pairs | Instant only fresh | Dynamic only fresh | Both fresh | Neither fresh | Instant − dynamic (pp) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.paired.map(
      (row) =>
        `| ${row.surface} | ${row.scheduledMs / 1000} | ${row.comparable} | ${row.instantOnly} | ${row.dynamicOnly} | ${row.bothFresh} | ${row.neitherFresh} | ${show(row.deltaPercentagePoints)} |`,
    ),
    "",
    "## Coverage and regressions",
    "",
    "| Arm | Surface | Eligible updates / planned | Fresh ever | Never observed, complete | Incomplete | Median first detection (ms) | Old only at horizon | Both at horizon | Late old-only / observed | Late mixed / observed | Control retained | Prior value seen in history probe | Read p95 (ms) |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.strata.map(
      (row) =>
        `| ${row.mode} | ${row.surface} | ${row.eligibleUpdates}/${row.plannedUpdates} | ${row.firstFreshObserved} | ${row.censoredAtHorizon} | ${row.incompleteWithoutFreshness} | ${show(row.medianFirstObservationMs)} | ${row.finalStates["old-only"]} | ${row.finalStates.both} | ${row.lateOldOnly}/${row.lateObserved} | ${row.lateBoth}/${row.lateObserved} | ${row.controlsPreserved}/${row.controlsObserved} | ${row.historyPriorValue}/${row.historyObserved} | ${show(row.readP95Ms)} |`,
    ),
    "",
    "## How to read the results",
    "",
    "- A fresh result mentions the new value alone. Mixed evidence is retained as its own state. Mention detection uses declared values and word boundaries, so paraphrases can require manual review.",
    "- Each paired comparison requires a confirmed old-value baseline and a successful observation in both arms at that target time. Pairs can drop out independently at each checkpoint.",
    "- First detection is the earliest successful poll that saw only the new value. The actual transition can occur between polls. Its median covers observed detections only. The count for complete windows with no detection is shown separately.",
    "- Late-import denominators include trials that were fresh at the final update checkpoint and had at least one successful late-phase probe. A trial can appear in both late-regression columns at different times.",
    "- The profile is queryless. Its historical probe shows available prior evidence. Hybrid search receives the explicit historical question.",
    "",
    "## Example late-import traces",
    "",
    ...drills.map(
      (row) =>
        `- \`${row.trialId}\` · ${row.mode} · ${row.surface} · ${row.observedMs} ms · **${row.evidence}**`,
    ),
    ...(drills.length ? [] : ["No mixed or old-only late-import observations captured."]),
    "",
    "See `observations.ndjson` for raw provider responses, errors, request timings, and exact probe questions. See `run.json` for the dataset hash, cohort, and configuration.",
    "",
  ].join("\n")
  writeFileSync(join(directory, "report.md"), markdown)
  writeFileSync(join(directory, "metrics.json"), JSON.stringify(results, null, 2) + "\n")
  const fields = [
    "trialId",
    "mode",
    "surface",
    "stage",
    "scheduledMs",
    "observedMs",
    "latencyMs",
    "evidence",
    "baselineEligible",
  ] as const
  const csvRows = rows
    .filter((row): row is Observation => row.type === "probe")
    .map((row) => fields.map((field) => csv(row[field])).join(","))
  writeFileSync(
    join(directory, "observations.csv"),
    [fields.join(","), ...csvRows].join("\n") + "\n",
  )
  return results
}
