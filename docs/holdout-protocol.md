# Four-fact live holdout

The shipping-city pilot suggested that a correction can appear in hybrid search before the dynamic profile drops its old value. The holdout asks whether this behavior repeats across unrelated fact types.

## Cohort

The four fact types are café order, meeting time zone, code editor, and departure airport. Each has three scenarios: a correction, a correction followed by a late historical import, and an unchanged control. Each scenario uses identical evidence in two separate namespaces, with dynamic or instant processing assigned to the update. The shipping scenarios are excluded.

Use the same probe schedule, search depth, write dates, and classification rules as the pilot. The holdout runs four scenario pairs concurrently. Review API errors and achieved probe times when comparing the two captures.

## Outcomes

- **Primary profile outcome.** At the 30-second and 120-second scheduled checkpoints, count eligible standard-correction pairs with only the new value under each mode. A pair requires successful reads and a confirmed old-value baseline in both arms. The denominator is facts rather than scenario variants.
- **Hybrid diagnostic.** At the same checkpoints, count mixed evidence among the standard corrections. Inspect raw memory and chunk fields to distinguish a current memory returned with an old source chunk from an outdated extracted memory. Mixed context describes the returned evidence. It does not score an agent's answer.
- **Late imports and controls.** For the late-import case, count observed old-only and mixed evidence after import among arms that had only the new value at the final pre-import checkpoint. Treat the absence of an eligible arm separately from an observed absence of regressions. Check whether unrelated writes preserve the original value in the unchanged controls.
- **Additional scenarios.** Report the full 12-scenario paired table as a secondary view. The two update scenarios for one fact are related and are not independent replications.

Report counts with denominators, observed timing bounds, probe errors, and at least one named exception if there is one. This cohort compares four controlled fact types. It does not establish real-world rates, long-run convergence, or end-to-end answer accuracy.

## Reproduction

```sh
node --experimental-strip-types src/cli.ts plan --facts drink,timezone,editor,airport --concurrency 4
node --env-file=.env --experimental-strip-types src/cli.ts run --live --facts drink,timezone,editor,airport --concurrency 4 --out runs/holdout-4-facts
node --experimental-strip-types scripts/holdout-report.ts runs/holdout-4-facts
python scripts/plot_capture.py runs/holdout-4-facts --cohort
```
