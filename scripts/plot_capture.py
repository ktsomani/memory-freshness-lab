"""Render observed evidence states from a saved capture."""

import argparse
import json
from collections import Counter
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


STATES = {
    "old-only": ("#c64b28", "s", "Old only"),
    "new-only": ("#08776d", "o", "New only"),
    "both": ("#7653a0", "D", "Both values"),
    "neither": ("#6d7886", "v", "Neither value"),
    "error": ("#22262d", "x", "Read error"),
}
PHASE_LABELS = {
    ("correction", "update"): "Correction",
    ("late-import", "update"): "Correction before late import",
    ("late-import", "late"): "After late import",
    ("unrelated-control", "update"): "Unchanged control",
}


def read_capture(directory):
    plan = json.loads((directory / "run.json").read_text(encoding="utf-8"))
    raw = (directory / "observations.ndjson").read_text(encoding="utf-8")
    lines = raw.split("\n")[:-1]
    return plan, [json.loads(line) for line in lines]


def plot(directory, output, fact_id, cohort=False):
    plan, records = read_capture(directory)
    selected = [
        item for item in plan["trials"]
        if (item["variant"] == "correction" if cohort else item["fact"]["id"] == fact_id)
    ]
    if not selected:
        raise ValueError(f"No scenarios for fact {fact_id!r}")

    labels = {}
    for trial in selected:
        if cohort:
            labels[(trial["id"], "update")] = trial["fact"]["field"].capitalize()
            continue
        for stage in ("update", "late"):
            if (trial["variant"], stage) in PHASE_LABELS:
                labels[(trial["id"], stage)] = PHASE_LABELS[(trial["variant"], stage)]

    timeline = {}
    for index, case in enumerate(labels):
        timeline[case] = index * 2.6
    observations = [
        row for row in records
        if row["type"] == "probe" and (row["trialId"], row["stage"]) in timeline
    ]
    if not observations:
        raise ValueError("The capture has no matching update or late-import probes.")

    figure, axes = plt.subplots(1, 2, figsize=(12.4, 6.6), sharey=True)
    figure.patch.set_facecolor("#f7f8fa")
    horizon = max(plan["checkpointsMs"]) / 1000
    ticks = [value / 1000 for value in plan["checkpointsMs"]]
    if len(ticks) > 8:
        ticks = list(dict.fromkeys([*ticks[::2], ticks[-1]]))
    observed_max = max(row["observedMs"] / 1000 for row in observations)
    x_max = max(horizon, observed_max)
    margin = max(0.25, x_max * 0.055)

    for axis, surface in zip(axes, ("profile", "hybrid")):
        axis.set_facecolor("#ffffff")
        axis.set_title("Profile" if surface == "profile" else "Hybrid search", loc="left",
                       fontsize=13, fontweight="semibold", pad=12)
        axis.set_xlim(-margin, x_max + margin)
        axis.set_xticks(ticks)
        axis.set_xlabel("Seconds after write acknowledgement")
        axis.grid(axis="x", color="#e7ebef", linewidth=1)
        axis.set_axisbelow(True)
        axis.tick_params(axis="both", length=0, labelcolor="#414b58", pad=7)
        for index, y in enumerate(timeline.values()):
            if index % 2 == 0:
                axis.axhspan(y - 0.45, y + 1.45, color="#f1f4f7", zorder=0)
        for row in observations:
            if row["surface"] != surface:
                continue
            y = timeline[(row["trialId"], row["stage"])] + (row["mode"] == "instant")
            color, marker, _ = STATES[row["evidence"]]
            axis.scatter(row["observedMs"] / 1000, y, color=color, marker=marker,
                         s=46, alpha=1 if row.get("baselineEligible") else 0.4, zorder=3)
        axis.set_ylim(-0.55, max(timeline.values()) + 1.55)
        axis.set_yticks([y + index for y in timeline.values() for index in (0, 1)])
        axis.invert_yaxis()
        for spine in axis.spines.values():
            spine.set_visible(False)
    axes[0].set_yticklabels([
        f"{label}  ·  {mode}" for label in labels.values() for mode in ("dynamic", "instant")
    ], fontsize=9)

    counts = Counter(row["evidence"] for row in observations)
    legend = [
        Line2D([0], [0], marker=marker, color=color, label=label, markersize=6, linestyle="none")
        for key, (color, marker, label) in STATES.items() if counts[key]
    ]
    figure.legend(handles=legend, loc="lower center", bbox_to_anchor=(0.62, 0.085), ncol=len(legend),
                  frameon=False, labelcolor="#374151")
    is_live = plan["mode"] == "live"
    prefix = "Synthetic workflow example"
    if is_live:
        prefix = "Live Supermemory holdout" if cohort else "Live Supermemory pilot"
    finished = any(row["type"] == "run-end" for row in records)
    timing = "actual response times" if is_live else "simulated probe times"
    subtitle = f"{prefix} · {len(selected)} paired scenarios · {timing}"
    if not finished:
        subtitle += " · capture incomplete"
    figure.text(0.04, 0.945, "When does retrieved evidence change?", fontsize=19, weight="bold", color="#18212b")
    figure.text(0.04, 0.898, subtitle, fontsize=11, color="#4b5867")
    note = ("Each marker is one observation. Faded markers have an unconfirmed baseline. "
            + ("Standard corrections only." if cohort else "The control is expected to retain the old value."))
    figure.text(0.04, 0.035, note, fontsize=9, color="#4b5867")
    figure.subplots_adjust(left=0.32, right=0.97, top=0.82, bottom=0.23, wspace=0.12)
    figure.savefig(output, dpi=190, facecolor=figure.get_facecolor())
    plt.close(figure)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--fact", default="shipping")
    parser.add_argument("--cohort", action="store_true", help="Plot all standard corrections together.")
    args = parser.parse_args()
    plot(args.run, args.out or args.run / "evidence-timeline.png", args.fact, args.cohort)
