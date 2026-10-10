#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Write HPA replica and metric samples every 2 UTC seconds. Does not print."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))
import e2e_timeline as timeline


def main() -> int:
    parser = argparse.ArgumentParser(description="Silent 2s HPA timeline JSONL writer")
    parser.add_argument("--output", required=True)
    parser.add_argument("--namespace", default=os.environ.get("NAMESPACE", "nemoclaw-gpu"))
    parser.add_argument("--hpa-name", default=os.environ.get("HPA_NAME", "nemoclaw-gpu-metrics-proxy"))
    parser.add_argument("--truncate", action="store_true")
    args = parser.parse_args()
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    if args.truncate:
        path.write_text("")
    while True:
        time.sleep(timeline.seconds_until_next_tick())
        timeline.write_hpa(path, args.namespace, args.hpa_name)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
