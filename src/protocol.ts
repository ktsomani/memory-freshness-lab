export const MODES = ["dynamic", "instant"] as const
export const SURFACES = ["profile", "hybrid"] as const
export type Mode = (typeof MODES)[number]
export type Surface = (typeof SURFACES)[number]
export type Variant = "correction" | "late-import" | "unrelated-control"
export type Stage = "baseline" | "update" | "late" | "history"
export type Evidence = "old-only" | "new-only" | "both" | "neither" | "error"

export interface Fact {
  id: string
  name: string
  scenario: string
  field: string
  old: string
  next: string
  distractor: string
}

export interface Trial {
  id: string
  fact: Fact
  variant: Variant
}

export interface Capture {
  observedMs: number
  latencyMs: number
  text: string[]
  raw?: unknown
  error?: string
}

export interface Observation extends Capture {
  type: "probe"
  at: string
  trialId: string
  variant: Variant
  namespace: string
  mode: Mode
  stage: Stage
  surface: Surface
  scheduledMs: number
  evidence: Evidence
  query: string
  baselineEligible?: boolean
}

export interface RunPlan {
  version: 1
  runId: string
  mode: "synthetic" | "live"
  createdAt: string
  datasetSha256: string
  trials: Trial[]
  checkpointsMs: number[]
  baselineMs: number[]
  searchLimit: number
  concurrency: number
  requestTimeoutMs: number
  background?: { content: string; sha256: string }
}

export interface Event {
  type: "write" | "trial-end" | "trial-error" | "run-end" | "run-aborted"
  at: string
  trialId?: string
  mode?: Mode
  namespace?: string
  stage?: Stage
  documentId?: string
  latencyMs?: number
  raw?: unknown
  error?: string
}

export type RecordRow = Observation | Event

export const dates = {
  original: "2024-01-08T12:00:00.000Z",
  historical: "2024-01-22T12:00:00.000Z",
  correction: "2024-02-05T12:00:00.000Z",
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

export function classifyEvidence(text: string[], fact: Fact): Evidence {
  const contains = (value: string) => {
    const needle = ` ${normalize(value)} `
    return text.some((item) => ` ${normalize(item)} `.includes(needle))
  }
  const old = contains(fact.old)
  const next = contains(fact.next)
  if (old && next) return "both"
  if (old) return "old-only"
  if (next) return "new-only"
  return "neither"
}

export function exactAnswer(actual: string, expected: string): boolean {
  return Boolean(normalize(expected)) && normalize(actual) === normalize(expected)
}

export function question(fact: Fact, stage: Stage): string {
  return stage === "history"
    ? `What was ${fact.name}'s ${fact.field} before February 5, 2024?`
    : `What is ${fact.name}'s current ${fact.field}?`
}

export function acceptedEvidence(trial: Trial, stage: Stage): Evidence {
  return stage === "history" || stage === "baseline" || trial.variant === "unrelated-control"
    ? "old-only"
    : "new-only"
}

export function expectedAnswer(trial: Trial, stage: Stage): string {
  return acceptedEvidence(trial, stage) === "old-only" ? trial.fact.old : trial.fact.next
}

export function trialsFor(facts: Fact[]): Trial[] {
  return facts.flatMap((fact) =>
    (["correction", "late-import", "unrelated-control"] as const).map((variant) => ({
      id: `${fact.id}-${variant}`,
      variant,
      fact,
    })),
  )
}

export function documentsFor(trial: Trial, background?: string) {
  const { fact } = trial
  const initial = `January 8, 2024. ${fact.scenario} ${fact.name} confirms: "My ${fact.field} is ${fact.old}."`
  return {
    seed: {
      date: dates.original,
      content: background ? `${background}\n\n---\n\n${initial}` : initial,
    },
    update: {
      date: dates.correction,
      content:
        trial.variant === "unrelated-control"
          ? `February 5, 2024. In an unrelated note, ${fact.name} says: "${fact.distractor}"`
          : `February 5, 2024. ${fact.name} sends a correction: "Please use ${fact.next} as my ${fact.field} from now on."`,
    },
    late: {
      date: dates.historical,
      content: `Archived note originally written January 22, 2024. At the time, ${fact.name} recorded ${fact.old} as their ${fact.field}.`,
    },
  }
}
