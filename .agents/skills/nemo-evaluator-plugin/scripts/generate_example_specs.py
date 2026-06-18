#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Print an exact-match metric bundle example.

Run from the repo root:

    uv run --frozen python skills/nemo-evaluator-plugin/scripts/generate_example_specs.py
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

DETERMINISTIC_HASH_SEED = "0"
JSON_OUTPUT_INDENT = 4
SUCCESS_EXIT_CODE = 0


def _ensure_deterministic_hash_seed() -> None:
    if os.environ.get("PYTHONHASHSEED") == DETERMINISTIC_HASH_SEED:
        return
    env = {**os.environ, "PYTHONHASHSEED": DETERMINISTIC_HASH_SEED}
    os.execvpe(sys.executable, [sys.executable, *sys.argv], env)


def _bundle(metric: Any) -> dict[str, Any]:
    _ensure_deterministic_hash_seed()

    from nemo_evaluator.shared.metric_bundles.bundles import bundle_metric
    from nemo_evaluator.shared.metric_bundles.cloudpickle import CloudpickleMetricBundlePackager

    return bundle_metric(metric, CloudpickleMetricBundlePackager()).model_dump(mode="json")


def build_metric_bundle_example() -> dict[str, Any]:
    """Return bundled JSON for one configured SDK metric."""
    from nemo_evaluator_sdk.metrics.exact_match import ExactMatchMetric

    metric = ExactMatchMetric(
        reference="{{item.gold_answer}}",
        candidate="{{item.prediction}}",
    )
    return _bundle(metric)


def main() -> int:
    print(json.dumps(build_metric_bundle_example(), indent=JSON_OUTPUT_INDENT))
    return SUCCESS_EXIT_CODE


if __name__ == "__main__":
    raise SystemExit(main())
