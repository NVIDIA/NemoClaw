# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Local-only Evaluator plugin SDK smoke example.

The default entrypoint prints an exact-match spec and does not submit jobs or
call hosted models. Pass --run to execute the same offline metric against a
running local NeMo Platform.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
from collections.abc import Iterable
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

DEFAULT_BASE_URL = "http://localhost:8080"
DEFAULT_ROWS = (
    {"expected": "blue", "model_output": "blue"},
    {"expected": "Jupiter", "model_output": "Saturn"},
)


def write_jsonl_dataset(path: Path, rows: Iterable[dict[str, Any]] = DEFAULT_ROWS) -> Path:
    """Write rows as JSONL and return the written path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    return path


def load_jsonl_rows(path: Path, *, limit: int | None = None) -> list[dict[str, Any]]:
    """Load plain JSONL or .gz JSONL rows."""
    opener = gzip.open if path.suffix == ".gz" else open
    rows: list[dict[str, Any]] = []

    with opener(path, "rt", encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                rows.append(json.loads(line))
            if limit is not None and len(rows) >= limit:
                break

    return rows


def build_exact_match_spec(rows: Iterable[dict[str, Any]] = DEFAULT_ROWS) -> dict[str, Any]:
    """Build a local exact-match spec that does not require model credentials."""
    from nemo_evaluator.shared.metric_bundles.bundles import bundle_metric
    from nemo_evaluator.shared.metric_bundles.cloudpickle import CloudpickleMetricBundlePackager
    from nemo_evaluator_sdk.metrics.exact_match import ExactMatchMetric

    metric = ExactMatchMetric(
        reference="{{item.expected}}",
        candidate="{{item.model_output}}",
    )
    return {
        "metrics": [bundle_metric(metric, CloudpickleMetricBundlePackager()).model_dump(mode="json")],
        "dataset": list(rows),
        "params": {"parallelism": 2, "limit_samples": 2},
    }


def run_local_exact_match(dataset_path: Path) -> Any:
    """Run the offline exact-match metric against a local platform."""
    from nemo_evaluator.sdk.types import RunConfig
    from nemo_evaluator_sdk.enums import MetricType
    from nemo_evaluator_sdk.metrics.exact_match import ExactMatchMetric
    from nemo_platform import NeMoPlatform

    client = NeMoPlatform(
        base_url=os.environ.get("NMP_BASE_URL", DEFAULT_BASE_URL),
        workspace="default",
    )
    try:
        evaluator = client.evaluator
        metric = ExactMatchMetric(
            type=MetricType.EXACT_MATCH,
            reference="{{item.expected}}",
            candidate="{{item.model_output}}",
        )
        return evaluator.run(metric=metric, dataset=dataset_path, config=RunConfig(limit_samples=2))
    finally:
        client.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Run local offline exact-match against NeMo Platform.")
    args = parser.parse_args(argv)

    with TemporaryDirectory(prefix="nemo-evaluator-smoke-") as tmpdir:
        dataset_path = write_jsonl_dataset(Path(tmpdir) / "exact-match.jsonl")

        if args.run:
            result = run_local_exact_match(dataset_path)
            result.print_summary()
            return 0

        print(json.dumps(build_exact_match_spec(load_jsonl_rows(dataset_path)), indent=2))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
