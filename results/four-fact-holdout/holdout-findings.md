# Four-fact Supermemory holdout

**LIVE · 4 fact types · 24/24 arms completed · 0 read errors**

## Standard corrections

| Surface | Checkpoint | Comparable fact pairs | Dynamic new only | Instant new only | Dynamic mixed | Instant mixed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| profile | 30s | 4 | 0 | 4 | 0 | 0 |
| profile | 120s | 4 | 0 | 4 | 0 | 0 |
| hybrid | 30s | 4 | 0 | 0 | 4 | 4 |
| hybrid | 120s | 4 | 0 | 0 | 4 | 4 |

### Profiles by fact

| Fact | 30s dynamic | 30s instant | 120s dynamic | 120s instant |
| --- | --- | --- | --- | --- |
| usual café drink | old-only (30.9s) | new-only (30.7s) | old-only (120.9s) | new-only (120.9s) |
| meeting time zone | old-only (30.8s) | new-only (30.8s) | old-only (120.8s) | new-only (120.8s) |
| primary code editor | old-only (30.7s) | new-only (30.6s) | old-only (120.6s) | new-only (120.6s) |
| preferred departure airport | old-only (30.7s) | new-only (30.6s) | old-only (120.7s) | new-only (120.7s) |

### Hybrid source attribution at 120 seconds

| Fact | Mode | Combined evidence | Extracted memories | Source chunks |
| --- | --- | --- | --- | --- |
| drink | dynamic | both | old-only | both |
| drink | instant | both | new-only | both |
| timezone | dynamic | both | old-only | both |
| timezone | instant | both | new-only | both |
| editor | dynamic | both | old-only | both |
| editor | instant | both | new-only | both |
| airport | dynamic | both | old-only | both |
| airport | instant | both | new-only | both |

## Late imports and unchanged controls

| Mode | Surface | Post-import observed / at risk | Saw old only | Saw mixed | Original value retained in controls |
| --- | --- | ---: | ---: | ---: | ---: |
| dynamic | profile | 0/0 | 0 | 0 | 4/4 |
| instant | profile | 3/3 | 0 | 0 | 4/4 |
| dynamic | hybrid | 0/0 | 0 | 0 | 4/4 |
| instant | hybrid | 0/0 | 0 | 0 | 4/4 |

Late-import counts cover arms that had only the new value at the final checkpoint before import. Counts of zero among zero eligible arms carry no evidence about regression. Hybrid results can retain useful historical source chunks, so the mixed flag alone cannot identify correctness or freshness of the extracted memory.

The primary denominator is independent fact types within this fixture set. The companion `report.md` covers all scenario variants, and `observations.ndjson` preserves the raw evidence. No answer model was evaluated in this capture.
