#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Analyze AOI inference CSV using whole-dataset threshold selection.

Rules implemented by this script:
- predict `NO_PASS` when `score > threshold`
- predict `PASS` when `score <= threshold`
- compare predictions against the CSV ground-truth label column
- treat any label other than `PASS` as `NO_PASS`
"""

from __future__ import annotations

import argparse
import csv
import math
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class InferenceRow:
    """One parsed CSV row."""

    row_index: int
    label: str
    normalized_label: str
    is_pass: bool
    score: float
    raw_row: dict[str, str]


@dataclass(frozen=True)
class ThresholdMetrics:
    """Binary classification metrics for one threshold."""

    threshold: float
    tp: int
    fp: int
    tn: int
    fn: int
    precision: float
    recall: float
    f1: float
    accuracy: float
    far: float
    predicted_no_pass_count: int
    actual_no_pass_count: int
    actual_pass_count: int


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description=(
            "Analyze AOI inference CSV using the rule "
            "`score > threshold => NO_PASS`."
        )
    )
    parser.add_argument("csv_path", type=Path, help="Path to the inference CSV.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory for analysis outputs. Defaults to <csv_stem>_analysis.",
    )
    parser.add_argument(
        "--label-column",
        default="label",
        help="Ground-truth label column name.",
    )
    parser.add_argument(
        "--score-column",
        default="siamese_score",
        help="Score column used for thresholding.",
    )
    parser.add_argument(
        "--pass-label",
        default="PASS",
        help="Label value treated as PASS. Everything else becomes NO_PASS.",
    )
    parser.add_argument(
        "--bins",
        type=int,
        default=40,
        help="Number of histogram bins for the distribution figure.",
    )
    return parser.parse_args()


def clean_label(label: str) -> str:
    """Normalize a label for case-insensitive comparison."""
    return str(label).strip().upper()


def safe_divide(numerator: float, denominator: float) -> float:
    """Safely divide two numbers."""
    if denominator == 0:
        return math.nan
    return numerator / denominator


def compute_f1(precision: float, recall: float) -> float:
    """Compute F1 score safely."""
    if math.isnan(precision) or math.isnan(recall):
        return math.nan
    denominator = precision + recall
    if denominator == 0:
        return math.nan
    return 2.0 * precision * recall / denominator


def format_float(value: float) -> str:
    """Format a float for text output."""
    if math.isnan(value):
        return "nan"
    return f"{value:.6f}"


def max_key(value: float) -> float:
    """Convert nan to negative infinity for max() sorting."""
    return -math.inf if math.isnan(value) else value


def load_rows(
    csv_path: Path,
    label_column: str,
    score_column: str,
    pass_label: str,
) -> tuple[list[InferenceRow], list[str]]:
    """Load and validate the inference CSV."""
    rows: list[InferenceRow] = []
    normalized_pass_label = clean_label(pass_label)

    with csv_path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"No CSV header found in {csv_path}.")
        fieldnames = list(reader.fieldnames)

        missing_columns = [
            column_name
            for column_name in (label_column, score_column)
            if column_name not in fieldnames
        ]
        if missing_columns:
            raise ValueError(
                f"Missing required columns: {', '.join(missing_columns)}. "
                f"Found columns: {', '.join(fieldnames)}"
            )

        for row_index, raw_row in enumerate(reader, start=2):
            raw_score = raw_row.get(score_column, "")
            raw_label = raw_row.get(label_column, "")
            if raw_score is None or str(raw_score).strip() == "":
                raise ValueError(f"Empty score at CSV line {row_index}.")

            try:
                score = float(raw_score)
            except ValueError as exc:
                raise ValueError(
                    f"Invalid score '{raw_score}' at CSV line {row_index}."
                ) from exc

            normalized_label = clean_label(raw_label)
            rows.append(
                InferenceRow(
                    row_index=row_index,
                    label=str(raw_label),
                    normalized_label=normalized_label,
                    is_pass=normalized_label == normalized_pass_label,
                    score=score,
                    raw_row=dict(raw_row),
                )
            )

    if not rows:
        raise ValueError(f"No data rows found in {csv_path}.")

    return rows, fieldnames


def build_candidate_thresholds(scores: list[float]) -> list[float]:
    """Build threshold candidates for the strict `score > threshold` rule."""
    unique_scores = sorted(set(scores))
    first_threshold = math.nextafter(unique_scores[0], float("-inf"))
    return [first_threshold, *unique_scores]


def compute_metrics_for_threshold(
    rows: list[InferenceRow],
    threshold: float,
) -> ThresholdMetrics:
    """Compute confusion-matrix counts and scalar metrics."""
    tp = fp = tn = fn = 0

    for row in rows:
        actual_no_pass = not row.is_pass
        predicted_no_pass = row.score > threshold

        if actual_no_pass and predicted_no_pass:
            tp += 1
        elif not actual_no_pass and predicted_no_pass:
            fp += 1
        elif not actual_no_pass and not predicted_no_pass:
            tn += 1
        else:
            fn += 1

    precision = safe_divide(tp, tp + fp)
    recall = safe_divide(tp, tp + fn)
    f1 = compute_f1(precision, recall)
    accuracy = safe_divide(tp + tn, len(rows))
    far = safe_divide(fp, fp + tn)

    return ThresholdMetrics(
        threshold=threshold,
        tp=tp,
        fp=fp,
        tn=tn,
        fn=fn,
        precision=precision,
        recall=recall,
        f1=f1,
        accuracy=accuracy,
        far=far,
        predicted_no_pass_count=tp + fp,
        actual_no_pass_count=tp + fn,
        actual_pass_count=tn + fp,
    )


def compute_all_metrics(rows: list[InferenceRow]) -> list[ThresholdMetrics]:
    """Evaluate all thresholds across the entire dataset."""
    scores = [row.score for row in rows]
    thresholds = build_candidate_thresholds(scores)
    return [compute_metrics_for_threshold(rows, threshold) for threshold in thresholds]


def select_best_f1_threshold(metrics: list[ThresholdMetrics]) -> ThresholdMetrics:
    """Select the threshold with the best F1 score."""
    return max(
        metrics,
        key=lambda item: (
            max_key(item.f1),
            max_key(item.recall),
            max_key(item.precision),
            item.threshold,
        ),
    )


def select_recall_100_threshold(
    metrics: list[ThresholdMetrics],
) -> ThresholdMetrics | None:
    """Select the best threshold among thresholds that achieve 100% recall."""
    eligible = [
        item
        for item in metrics
        if item.actual_no_pass_count > 0
        and math.isclose(item.recall, 1.0, rel_tol=0.0, abs_tol=1e-12)
    ]
    if not eligible:
        return None

    return max(
        eligible,
        key=lambda item: (
            max_key(item.f1),
            max_key(item.precision),
            item.threshold,
        ),
    )


def write_threshold_metrics_csv(
    destination: Path,
    metrics: list[ThresholdMetrics],
) -> None:
    """Write per-threshold metrics to CSV."""
    with destination.open("w", newline="", encoding="utf-8") as handle:
        fieldnames = list(asdict(metrics[0]).keys())
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for item in metrics:
            writer.writerow(asdict(item))


def build_best_f1_missed_no_pass_rows(
    rows: list[InferenceRow],
    threshold: float,
    score_column: str,
    pass_label: str,
) -> list[dict[str, str]]:
    """Build missed-NO_PASS review rows for the Best F1 threshold."""
    missed_no_pass_rows: list[dict[str, str]] = []

    for row in rows:
        predicted_no_pass = row.score > threshold
        if row.is_pass or predicted_no_pass:
            continue

        review_row = dict(row.raw_row)
        review_row["analysis_row_index"] = str(row.row_index)
        review_row["analysis_score"] = format_float(row.score)
        review_row["analysis_threshold"] = format_float(threshold)
        review_row["analysis_actual_label_group"] = "NO_PASS"
        review_row["analysis_predicted_label_group"] = pass_label
        review_row["analysis_outcome"] = "MISSED_NO_PASS"
        if score_column not in review_row:
            review_row[score_column] = format_float(row.score)
        missed_no_pass_rows.append(review_row)

    missed_no_pass_rows.sort(
        key=lambda item: (float(item["analysis_score"]), int(item["analysis_row_index"]))
    )
    return missed_no_pass_rows


def write_review_csv(
    destination: Path,
    fieldnames: list[str],
    rows: list[dict[str, str]],
) -> None:
    """Write review rows while preserving the original CSV column order."""
    analysis_fieldnames = [
        "analysis_row_index",
        "analysis_score",
        "analysis_threshold",
        "analysis_actual_label_group",
        "analysis_predicted_label_group",
        "analysis_outcome",
    ]
    output_fieldnames = list(fieldnames)
    for column_name in analysis_fieldnames:
        if column_name not in output_fieldnames:
            output_fieldnames.append(column_name)

    with destination.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=output_fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def format_far_percentage(far: float) -> str:
    """Format FAR as a percentage string for emphasis."""
    if math.isnan(far):
        return "nan"
    return f"{far * 100:.4f}%"


def format_threshold_summary(title: str, metrics: ThresholdMetrics) -> list[str]:
    """Format one threshold summary block."""
    return [
        title,
        f"  threshold: {format_float(metrics.threshold)}",
        f"  >>> FAR (False Alarm Rate): {format_far_percentage(metrics.far)}  "
        f"(FP={metrics.fp} / (FP={metrics.fp} + TN={metrics.tn}))",
        f"  precision: {format_float(metrics.precision)}",
        f"  recall: {format_float(metrics.recall)}",
        f"  f1: {format_float(metrics.f1)}",
        f"  accuracy: {format_float(metrics.accuracy)}",
        "  confusion matrix (rows=actual, cols=predicted; PASS, NO_PASS):",
        f"    TN={metrics.tn}  FP={metrics.fp}",
        f"    FN={metrics.fn}  TP={metrics.tp}",
    ]


def write_summary(
    destination: Path,
    rows: list[InferenceRow],
    recall_100_threshold: ThresholdMetrics | None,
    best_f1_threshold: ThresholdMetrics,
    score_column: str,
    pass_label: str,
    generated_plot_paths: list[Path],
    best_f1_missed_no_pass_count: int,
) -> None:
    """Write a concise text summary."""
    pass_count = sum(row.is_pass for row in rows)
    no_pass_count = len(rows) - pass_count

    lines = [
        "AOI inference threshold analysis",
        "",
        "Prediction rule:",
        f"  score > threshold => NO_PASS",
        f"  score <= threshold => {pass_label}",
        "",
        "Ground-truth rule:",
        f"  label == {pass_label} => {pass_label}",
        f"  label != {pass_label} => NO_PASS",
        "",
        "Key metric:",
        "  FAR (False Alarm Rate) = FP / (FP + TN)",
        "  = fraction of actual PASS items falsely predicted as NO_PASS",
        "",
        "Threshold search scope:",
        "  all threshold candidates are evaluated on the entire dataset",
        "",
        f"Input score column: {score_column}",
        f"Total rows: {len(rows)}",
        f"PASS rows: {pass_count}",
        f"NO_PASS rows: {no_pass_count}",
        "",
    ]

    if recall_100_threshold is None:
        lines.extend(
            [
                "Best threshold that hits 100% recall:",
                "  unavailable because no threshold achieved recall = 1.0",
                "",
            ]
        )
    else:
        lines.extend(
            format_threshold_summary(
                "Best threshold that hits 100% recall:",
                recall_100_threshold,
            )
        )
        lines.append("")

    lines.extend(
        format_threshold_summary(
            "Best threshold by F1 score:",
            best_f1_threshold,
        )
    )
    lines.append("")
    lines.append(
        "Best F1 threshold missed NO_PASS samples "
        f"(actual NO_PASS, predicted {pass_label}): "
        f"{best_f1_missed_no_pass_count}"
    )
    lines.append("")
    lines.append("Files written:")
    lines.append("  threshold_metrics.csv")
    lines.append("  summary.txt")
    lines.append("  best_f1_missed_no_pass_samples.csv")
    for plot_path in generated_plot_paths:
        lines.append(f"  {plot_path.name}")
    if not generated_plot_paths:
        lines.append("  no plot files generated")

    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_histogram_bins(scores: list[float], bins: int) -> list[float]:
    """Build shared histogram bin edges without NumPy."""
    if bins < 1:
        raise ValueError("--bins must be at least 1.")

    score_min = min(scores)
    score_max = max(scores)
    if math.isclose(score_min, score_max):
        padding = max(abs(score_min) * 0.05, 1e-6)
        return [score_min - padding, score_max + padding]

    step = (score_max - score_min) / bins
    return [score_min + idx * step for idx in range(bins + 1)]


def plot_confusion_matrix(
    output_path: Path,
    metrics: ThresholdMetrics,
    title: str,
) -> None:
    """Plot one confusion matrix."""
    import matplotlib.pyplot as plt

    matrix = [
        [metrics.tn, metrics.fp],
        [metrics.fn, metrics.tp],
    ]
    total = sum(sum(row) for row in matrix)
    max_value = max(max(row) for row in matrix) if total > 0 else 0

    figure, axis = plt.subplots(figsize=(6, 5))
    image = axis.imshow(matrix, cmap="Blues")
    axis.set_xticks([0, 1], labels=["PASS", "NO_PASS"])
    axis.set_yticks([0, 1], labels=["PASS", "NO_PASS"])
    axis.set_xlabel("Predicted")
    axis.set_ylabel("Actual")
    axis.set_title(title)

    for row_index, row in enumerate(matrix):
        for column_index, value in enumerate(row):
            percentage = safe_divide(value, total) * 100.0
            text = (
                f"{value}\n({percentage:.2f}%)"
                if not math.isnan(percentage)
                else f"{value}"
            )
            text_color = "white" if value > max_value * 0.5 else "black"
            axis.text(
                column_index,
                row_index,
                text,
                ha="center",
                va="center",
                color=text_color,
                fontsize=11,
            )

    figure.colorbar(image, ax=axis, fraction=0.046, pad=0.04)
    figure.tight_layout()
    figure.savefig(output_path, dpi=220)
    plt.close(figure)


def plot_outputs(
    output_dir: Path,
    pass_scores: list[float],
    no_pass_scores: list[float],
    recall_100_threshold: ThresholdMetrics | None,
    best_f1_threshold: ThresholdMetrics,
    bins: int,
) -> list[Path]:
    """Create plots if matplotlib is installed."""
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return []

    generated_paths: list[Path] = []
    all_scores = pass_scores + no_pass_scores
    histogram_bins = build_histogram_bins(all_scores, bins)

    figure, axes = plt.subplots(2, 1, figsize=(10, 8), sharex=True)
    axes[0].hist(pass_scores, bins=histogram_bins, color="#4e79a7", alpha=0.85)
    axes[0].set_title(f"PASS score distribution (n={len(pass_scores)})")
    axes[0].set_ylabel("Count")
    axes[0].grid(alpha=0.25)

    axes[1].hist(no_pass_scores, bins=histogram_bins, color="#e15759", alpha=0.85)
    axes[1].set_title(f"NO_PASS score distribution (n={len(no_pass_scores)})")
    axes[1].set_xlabel("Score")
    axes[1].set_ylabel("Count")
    axes[1].grid(alpha=0.25)

    if recall_100_threshold is not None:
        for axis in axes:
            axis.axvline(
                recall_100_threshold.threshold,
                color="black",
                linestyle="--",
                linewidth=1.5,
                label=f"100% recall threshold = {recall_100_threshold.threshold:.6f}",
            )
            axis.legend(loc="upper right")

    figure.suptitle("Score distributions by label")
    figure.tight_layout()
    distribution_path = output_dir / "score_distribution_with_recall_100_threshold.png"
    figure.savefig(distribution_path, dpi=220)
    plt.close(figure)
    generated_paths.append(distribution_path)

    if recall_100_threshold is not None:
        recall_100_confusion_path = output_dir / "confusion_matrix_recall_100.png"
        plot_confusion_matrix(
            recall_100_confusion_path,
            recall_100_threshold,
            "Confusion Matrix at 100% Recall Threshold\n"
            f"threshold = {format_float(recall_100_threshold.threshold)}",
        )
        generated_paths.append(recall_100_confusion_path)

    best_f1_confusion_path = output_dir / "confusion_matrix_best_f1.png"
    plot_confusion_matrix(
        best_f1_confusion_path,
        best_f1_threshold,
        "Confusion Matrix at Best F1 Threshold\n"
        f"threshold = {format_float(best_f1_threshold.threshold)}",
    )
    generated_paths.append(best_f1_confusion_path)

    return generated_paths


def main() -> None:
    """Run the analysis."""
    args = parse_args()
    csv_path = args.csv_path.resolve()
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV file not found: {csv_path}")

    output_dir = (
        args.output_dir.resolve()
        if args.output_dir is not None
        else csv_path.parent / f"{csv_path.stem}_analysis"
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    rows, fieldnames = load_rows(
        csv_path=csv_path,
        label_column=args.label_column,
        score_column=args.score_column,
        pass_label=args.pass_label,
    )
    metrics = compute_all_metrics(rows)
    recall_100_threshold = select_recall_100_threshold(metrics)
    best_f1_threshold = select_best_f1_threshold(metrics)
    best_f1_missed_no_pass_rows = build_best_f1_missed_no_pass_rows(
        rows=rows,
        threshold=best_f1_threshold.threshold,
        score_column=args.score_column,
        pass_label=args.pass_label,
    )

    write_threshold_metrics_csv(output_dir / "threshold_metrics.csv", metrics)
    write_review_csv(
        output_dir / "best_f1_missed_no_pass_samples.csv",
        fieldnames=fieldnames,
        rows=best_f1_missed_no_pass_rows,
    )
    pass_scores = [row.score for row in rows if row.is_pass]
    no_pass_scores = [row.score for row in rows if not row.is_pass]
    plot_paths = plot_outputs(
        output_dir=output_dir,
        pass_scores=pass_scores,
        no_pass_scores=no_pass_scores,
        recall_100_threshold=recall_100_threshold,
        best_f1_threshold=best_f1_threshold,
        bins=args.bins,
    )
    write_summary(
        destination=output_dir / "summary.txt",
        rows=rows,
        recall_100_threshold=recall_100_threshold,
        best_f1_threshold=best_f1_threshold,
        score_column=args.score_column,
        pass_label=args.pass_label,
        generated_plot_paths=plot_paths,
        best_f1_missed_no_pass_count=len(best_f1_missed_no_pass_rows),
    )

    print(f"Input CSV: {csv_path}")
    print(f"Output directory: {output_dir}")
    print(f"Rows analyzed: {len(rows)}")
    print(f"PASS rows: {len(pass_scores)}")
    print(f"NO_PASS rows: {len(no_pass_scores)}")
    if recall_100_threshold is None:
        print("100% recall threshold: unavailable")
    else:
        print(
            "100% recall threshold: "
            f"{format_float(recall_100_threshold.threshold)} "
            f"(FAR={format_far_percentage(recall_100_threshold.far)}, "
            f"precision={format_float(recall_100_threshold.precision)}, "
            f"recall={format_float(recall_100_threshold.recall)}, "
            f"f1={format_float(recall_100_threshold.f1)})"
        )
    print(
        "Best F1 threshold: "
        f"{format_float(best_f1_threshold.threshold)} "
        f"(FAR={format_far_percentage(best_f1_threshold.far)}, "
        f"precision={format_float(best_f1_threshold.precision)}, "
        f"recall={format_float(best_f1_threshold.recall)}, "
        f"f1={format_float(best_f1_threshold.f1)})"
    )
    print(
        "Best F1 missed-NO_PASS review CSV: "
        f"{output_dir / 'best_f1_missed_no_pass_samples.csv'} "
        f"(rows={len(best_f1_missed_no_pass_rows)})"
    )
    print(f"Threshold metrics CSV: {output_dir / 'threshold_metrics.csv'}")
    print(f"Summary: {output_dir / 'summary.txt'}")
    if plot_paths:
        for plot_path in plot_paths:
            print(f"Plot: {plot_path}")
    else:
        print("Plots skipped because matplotlib is not installed.")


if __name__ == "__main__":
    main()
