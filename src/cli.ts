import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { replayAnswers, selectReplayRows } from "./answer.ts"
import { captureRun, errorMessage, requestBounds } from "./capture.ts"
import { trialsFor } from "./protocol.ts"
import type { Fact, RunPlan } from "./protocol.ts"
import { writeReport } from "./report.ts"
import { createSupermemory, createSyntheticTransport } from "./transport.ts"

const defaultDataset = new URL("../datasets/facts-v1.json", import.meta.url)
const captureOptions = {
  out: { type: "string" },
  dataset: { type: "string" },
  facts: { type: "string" },
  background: { type: "string" },
  limit: { type: "string" },
  checkpoints: { type: "string" },
  baseline: { type: "string" },
  concurrency: { type: "string" },
  "search-limit": { type: "string" },
  "timeout-ms": { type: "string" },
  live: { type: "boolean" },
} as const

function positive(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`Expected a positive integer up to ${max}, got ${value}`)
  }
  return parsed
}

function schedule(value: string | undefined, fallback: number[]) {
  if (!value) return fallback
  if (!/^0(,\d+)+$/.test(value))
    throw new Error("Checkpoint schedule must start at 0 and use comma-separated seconds.")
  const offsets = value.split(",").map(Number)
  if (
    offsets.length > 20 ||
    offsets.at(-1)! > 1800 ||
    offsets.some((offset, index) => index > 0 && offset <= offsets[index - 1])
  ) {
    throw new Error("Use up to 20 strictly increasing checkpoints ending within 1,800 seconds.")
  }
  return offsets.map((offset) => offset * 1000)
}

function factsFrom(content: string): Fact[] {
  const facts = JSON.parse(content)
  const fields = ["id", "name", "scenario", "field", "old", "next", "distractor"] as const
  if (!Array.isArray(facts) || !facts.length)
    throw new Error("Expected an array of fact definitions.")
  const used = new Set<string>()
  for (const fact of facts) {
    if (!fact || fields.some((field) => typeof fact[field] !== "string" || !fact[field].trim())) {
      throw new Error("Incomplete fact definition.")
    }
    if (!/^[a-z0-9-]{1,25}$/.test(fact.id) || used.has(fact.id))
      throw new Error(`Invalid or duplicate fact ID: ${fact.id}`)
    const normalized = (value: string) =>
      value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
    const old = normalized(fact.old),
      next = normalized(fact.next)
    if (!old || !next || ` ${old} `.includes(` ${next} `) || ` ${next} `.includes(` ${old} `)) {
      throw new Error(`Fact ${fact.id} must use distinguishable old and new values.`)
    }
    used.add(fact.id)
  }
  return facts
}

function makePlan(
  values: ReturnType<typeof parseArgs<{ options: typeof captureOptions }>>["values"],
  live: boolean,
): RunPlan {
  const source = readFileSync(values.dataset ?? defaultDataset, "utf8")
  const facts = factsFrom(source)
  const requested = values.facts?.split(",").map((id) => id.trim())
  if (requested) {
    const known = new Set(facts.map(({ id }) => id))
    if (requested.length !== new Set(requested).size || requested.some((id) => !known.has(id))) {
      throw new Error("--facts requires comma-separated, unique fact IDs from the dataset.")
    }
    if (values.limit)
      throw new Error("Use --facts without --limit to keep all scenarios in each fact group.")
  }
  const allTrials = trialsFor(requested ? facts.filter(({ id }) => requested.includes(id)) : facts)
  const background = values.background ? readFileSync(values.background, "utf8") : undefined
  if (background !== undefined && (!background.trim() || Buffer.byteLength(background) > 200000)) {
    throw new Error(
      "Background history must be a non-empty UTF-8 text file of at most 200,000 bytes.",
    )
  }
  return {
    version: 1,
    runId: randomBytes(8).toString("hex"),
    mode: live ? "live" : "synthetic",
    createdAt: new Date().toISOString(),
    datasetSha256: createHash("sha256").update(source).digest("hex"),
    trials: allTrials.slice(0, positive(values.limit, allTrials.length, allTrials.length)),
    checkpointsMs: schedule(values.checkpoints, [0, 5000, 15000, 30000, 60000, 120000]),
    baselineMs: schedule(values.baseline, [0, 15000, 30000, 60000, 120000, 240000]),
    searchLimit: positive(values["search-limit"], 10, 30),
    concurrency: positive(values.concurrency, 1, 4),
    requestTimeoutMs: positive(values["timeout-ms"], 10000, 120000),
    ...(background && {
      background: {
        content: background,
        sha256: createHash("sha256").update(background).digest("hex"),
      },
    }),
  }
}

function usage() {
  console.log(`Memory Freshness Lab

  node --experimental-strip-types src/cli.ts plan [--limit 3]
  node --experimental-strip-types src/cli.ts demo [--out runs/demo]
  node --experimental-strip-types src/cli.ts run --live [--limit 3] [--out runs/pilot]
  node --experimental-strip-types src/cli.ts report --run <directory>
  node --experimental-strip-types src/cli.ts answer-plan --run <directory> [--trial <id>]
  node --experimental-strip-types src/cli.ts answer --run <directory> [--trial <id>] [--model gpt-4.1-mini]

Capture options: --dataset PATH --facts drink,timezone --background PATH
                 --checkpoints 0,5,15,30,60,120
                 --baseline 0,15,30,60,120,240 --concurrency 1
                 --search-limit 10 --timeout-ms 10000
Model replay options: --max-calls 24 --timeout-ms 15000
Keys: SUPERMEMORY_API_KEY for live capture, OPENAI_API_KEY for answer replay.`)
}

async function main(argv: string[]) {
  const [command, ...args] = argv
  if (!command || command === "help" || command === "--help") return usage()
  if (["plan", "demo", "run"].includes(command)) {
    const { values } = parseArgs({ args, options: captureOptions })
    if (command === "run" && !values.live)
      throw new Error("Use run --live to make billable Supermemory requests.")
    if (command === "demo" && values.live) throw new Error("Use run --live for a live capture.")
    const plan = makePlan(values, command === "run" || command === "plan")
    const bounds = requestBounds(plan)
    console.log(
      JSON.stringify(
        {
          mode: plan.mode,
          trials: plan.trials.length,
          ...bounds,
          checkpointsMs: plan.checkpointsMs,
          backgroundBytes: Buffer.byteLength(plan.background?.content ?? ""),
        },
        null,
        2,
      ),
    )
    if (command === "plan") return
    const key = process.env.SUPERMEMORY_API_KEY
    if (command === "run" && !key)
      throw new Error("SUPERMEMORY_API_KEY is required for a live run.")
    const dir = resolve(values.out ?? join("runs", `${command}-${plan.runId}`))
    mkdirSync(dirname(dir), { recursive: true })
    mkdirSync(dir)
    writeFileSync(join(dir, "run.json"), JSON.stringify(plan, null, 2) + "\n")
    const journal = join(dir, "observations.ndjson")
    writeFileSync(journal, "", { flag: "wx" })
    const transport =
      key && command === "run"
        ? createSupermemory(key, plan.searchLimit, plan.requestTimeoutMs)
        : createSyntheticTransport()
    await captureRun(plan, transport, journal)
    const report = writeReport(dir)
    console.log(
      JSON.stringify(
        {
          directory: dir,
          completedArms: report.completedArms,
          failedArms: report.failedArms,
          probeErrors: report.probeErrors,
        },
        null,
        2,
      ),
    )
    if (report.failedArms || report.probeErrors) process.exitCode = 1
    return
  }
  if (["report", "answer-plan", "answer"].includes(command)) {
    const { values } = parseArgs({
      args,
      options: {
        run: { type: "string" },
        trial: { type: "string" },
        model: { type: "string" },
        "max-calls": { type: "string" },
        "timeout-ms": { type: "string" },
      },
    })
    if (!values.run) throw new Error("--run is required.")
    const directory = resolve(values.run)
    if (command === "report") {
      const { completedArms, failedArms } = writeReport(directory)
      console.log(JSON.stringify({ directory, completedArms, failedArms }, null, 2))
      return
    }
    if (command === "answer-plan") {
      const { plan, selected } = selectReplayRows(directory, values.trial)
      console.log(JSON.stringify({ source: plan.mode, modelCalls: selected.length }, null, 2))
      return
    }
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new Error("OPENAI_API_KEY is required for answer replay.")
    const model = values.model ?? "gpt-4.1-mini"
    if (!/^[a-zA-Z0-9_.-]{1,90}$/.test(model)) throw new Error("Use an OpenAI model ID.")
    const result = await replayAnswers({
      directory,
      key,
      model,
      trialId: values.trial,
      maxCalls: positive(values["max-calls"], 24, 2000),
      timeoutMs: positive(values["timeout-ms"], 15000, 120000),
    })
    console.log(JSON.stringify(result, null, 2))
    if (result.counts["model-error"]) process.exitCode = 1
    return
  }
  throw new Error(`Unknown command: ${command}. Use --help for usage.`)
}

main(process.argv.slice(2)).catch((error) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
