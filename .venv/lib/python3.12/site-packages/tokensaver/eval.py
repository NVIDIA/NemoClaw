"""Metrics reporting helpers for TokenSaver outputs."""

from __future__ import annotations

import json
from pathlib import Path


def load_metrics(output_dir: str | Path) -> dict:
    """Load METRICS.json from the build output directory."""
    metrics_path = Path(output_dir) / "METRICS.json"
    return json.loads(metrics_path.read_text())


def print_metrics(metrics: dict) -> None:
    """Print a compact metrics report."""
    repo = metrics["repo"]
    repo_ratio = repo["compression_ratio"]
    repo_ratio_text = f"{repo_ratio:.2f}x" if repo_ratio else "n/a"
    print(f"\n{'=' * 60}")
    print(f"TokenSaver Metrics: {metrics['project']}")
    print(f"{'=' * 60}\n")

    print(f"Tokenizer:              {metrics['tokenizer']}")
    print(f"Union source files:     {repo['source_file_count']}")
    print(f"Union source tokens:    {repo['union_source_tokens']:,}")
    print(f"Bundle output tokens:   {repo['bundle_tokens']:,}")
    print(f"Compression ratio:      {repo_ratio_text}")
    print(f"Overlap source tokens:  {repo['overlap_source_tokens']:,}")

    print(f"\n{'Artifact':<20} {'Source':>10} {'Output':>10} {'Ratio':>8}")
    print(f"{'-' * 20} {'-' * 10} {'-' * 10} {'-' * 8}")
    for artifact in metrics["artifacts"]:
        ratio = artifact["compression_ratio"]
        ratio_text = f"{ratio:.2f}x" if ratio else "n/a"
        print(
            f"{artifact['name']:<20} "
            f"{artifact['source_tokens']:>10,} "
            f"{artifact['output_tokens']:>10,} "
            f"{ratio_text:>8}"
        )
    print()
