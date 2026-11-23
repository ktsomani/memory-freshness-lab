# Memory Freshness Lab

How long after a user corrects a fact can an agent retrieve the new information, and can a late-arriving historical note reintroduce the old value?

Memory Freshness Lab measures this with the [Supermemory v5 API](https://api.supermemory.ai/reference). It captures profiles and hybrid results on a fixed clock, compares processing modes on paired scenarios, and replays saved evidence through an optional answer model. The protocol focuses on the interval immediately after a write, complementing the final-answer checks in [LongMemEval-S](https://supermemory.ai/research/runs/longmemeval/).

## Live results

In a 12-scenario holdout across four fact types, instant profiles showed the corrected value in all four standard corrections at the 120-second checkpoint. Dynamic profiles still showed the original value. Hybrid search returned both values under both processing modes, with different extracted memories behind those results.

[Read the findings and view the chart](results/four-fact-holdout/) · [Study protocol](docs/holdout-protocol.md)

The [voice call demo](experiments/voice/) compares a call-start snapshot with a per-turn lookup and a bounded fallback. It supports both saved evidence replay and live Supermemory calls with an optional on-device microphone.

## Quick start

Requires Node.js 22.13 or later. The harness has zero runtime dependencies.

```sh
npm test
node --experimental-strip-types src/cli.ts demo --out runs/demo
```

Open `runs/demo/report.md`. This deterministic simulation exercises all 36 scenarios and both modes. Its report identifies the output as synthetic.

## Live pilot

Set `SUPERMEMORY_API_KEY` in your shell. Use a dedicated evaluation account or project if possible. Plan prints an upper bound on API calls without contacting a provider.

```sh
node --experimental-strip-types src/cli.ts plan --limit 3
node --experimental-strip-types src/cli.ts run --live --limit 3 --out runs/pilot
node --experimental-strip-types src/cli.ts report --run runs/pilot
```

The first three scenarios cover a shipping city correction, a delayed historical note, and an unchanged control. The full run uses all 36 scenarios. `--concurrency` runs up to four scenario pairs at once. The default is one pair at a time to limit request bursts. Live capture makes billable requests, and [instant processing bills an additional operation per document](https://supermemory.ai/docs/ingestion/add-memories). Each run creates fresh, uniquely named namespaces beginning with `mfl-`.

To test the same cases amid unrelated information, pass `--background path/to/history.txt`. The harness prepends that history to each seed and stores its exact text and hash in the run manifest. Use synthetic or public-domain background material if you intend to publish the run artifacts. The built-in cohort uses short histories to isolate the mutation and late-import effects.

Use `--facts drink,timezone,editor,airport` for a balanced holdout that excludes the shipping pilot. It selects all three scenario types per named fact, with independent fresh namespaces for both processing modes.

## Study design

1. **Fixed cohort.** The versioned dataset contains 12 fact types across three scenario designs. Each case runs in two separate namespaces. Each pair receives the same text, dates, search depth, and probe schedule. The harness alternates which arm starts first.
2. **Confirmed baseline.** Both arms seed the old value with instant processing. The harness observes profile and hybrid search before mutation. A surface is eligible for paired analysis if its final baseline observation contains the old value alone. Baseline misses are reflected in the denominators and preserved in the journal.
3. **Timed mutation.** The update uses either dynamic or instant processing. Both surfaces are probed at 0, 5, 15, 30, 60, and 120 seconds, anchored to write acknowledgement. The journal records the target time, actual response time, and client request latency. In late-import cases, the historical note is submitted after the update window, with its original authoring date and a fresh document ID.
4. **Separated measurements.** Classify every observation as old only, new only, mixed, neither, or error. Report paired checkpoint differences, first detection, complete windows without detection, incomplete windows, late regressions, and unchanged controls. Hybrid search receives an explicit historical question at the end. Profile probes show the available profile context because that endpoint is queryless.
5. **Independent answer replay.** Model generation happens over saved captures after the timing experiment. Each replay uses the exact question and normalized evidence strings recorded at capture. Exact-value scoring and failure labels can be audited against the raw provider response. In particular, a model miss with expected evidence present is distinct from a miss with only competing evidence.

Scores are descriptive for this cohort. Exact phrase matching can miss paraphrases and can count a value mentioned only as history. Mixed results and raw response records make those cases reviewable. A poll bounds when freshness became observable. It cannot pinpoint when the provider updated the underlying memory.

## Replay an answer model

Set `OPENAI_API_KEY`. Plan the call count before replay. The example uses the six final surface and stage captures per processing mode for a late-import trial.

```sh
node --experimental-strip-types src/cli.ts answer-plan --run runs/pilot --trial shipping-late-import
node --experimental-strip-types src/cli.ts answer --run runs/pilot --trial shipping-late-import --model gpt-4.1-mini
```

Replay selects the final update and late checkpoints plus the historical probe when present. It preserves the original evidence, response, exact scoring label, and model latency in a separate NDJSON file. Use `--max-calls` to set the request budget for larger replays. This stage can run independently of Supermemory after capture.

## Run files

| File | Contents |
| --- | --- |
| `run.json` | Protocol version, dataset SHA-256, scenario definitions, request timeout, and schedules |
| `observations.ndjson` | Incremental journal of write acknowledgements, raw API responses, timings, and errors |
| `observations.csv` | One row per observation for plotting or analysis |
| `metrics.json` | Structured paired counts and denominators |
| `report.md` | Human-readable findings, coverage, and pointers to late-import traces |
| `answers-*.ndjson` | Optional model replay responses and per-answer diagnostics |

Run directories are created exclusively. Interrupted captures remain reportable and are marked incomplete. A new live run uses a fresh namespace pair so that an interrupted timing window cannot be mistaken for a continuous one. Terminal authorization, quota, and rate-limit failures stop scheduling new work. The harness records transient failures at their scheduled position instead of retrying and shifting the observation clock.

To plot the evidence timeline for one fact, run this optional script with Python and Matplotlib installed. It reads saved artifacts without calling either API.

```sh
python scripts/plot_capture.py runs/pilot --fact shipping
```
