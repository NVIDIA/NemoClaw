#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Contract: client and HPA timeline rows share even-second UTC timestamps."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import e2e_timeline as timeline

assert timeline.INTERVAL_SEC == 2
assert timeline.aligned_epoch(1_700_000_001.9) % 2 == 0
assert timeline.aligned_ts(1_700_000_000.0) == timeline.aligned_ts(1_700_000_001.9)
assert timeline.aligned_ts(1_700_000_000.0) == "2023-11-14T22:13:20Z"
assert 0.05 < timeline.seconds_until_next_tick(1_700_000_001.0) <= 2.0
assert timeline.quantity("32500m") == 32.5
assert timeline.quantity("40") == 40.0
assert timeline.quantity("46514") == 46514.0

timeline.reset_counts()
timeline.note_user(0, 3, 1, 120)
timeline.note_user(1, 4, 0, 80)
rows = timeline.rows_for_users(3)
assert rows[0] == {"user": 0, "ok": 3, "err": 1, "tokens": 120}
assert rows[1] == {"user": 1, "ok": 4, "err": 0, "tokens": 80}
assert rows[2] == {"user": 2, "ok": 0, "err": 0, "tokens": 0}

with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    client = out / "client-timeline.jsonl"
    hpa = out / "hpa-timeline.jsonl"
    now = 1_700_000_000.0
    timeline.write_client(client, max_tokens=16384, inflight=2, users=rows, now=now)
    timeline.append_jsonl(
        hpa,
        {
            "ts": timeline.aligned_ts(now),
            "current_replicas": 3,
            "desired_replicas": 4,
            "min_replicas": 1,
            "max_replicas": 8,
            "metric": "gpu_utilization_percent",
            "current_value": 52.0,
            "target_value": 40.0,
        },
    )
    client_row = json.loads(client.read_text().splitlines()[0])
    hpa_row = json.loads(hpa.read_text().splitlines()[0])
assert client_row["ts"] == hpa_row["ts"] == "2023-11-14T22:13:20Z"
assert client_row["total_ok"] == 7
assert client_row["total_tokens"] == 200
assert hpa_row["desired_replicas"] == 4
print("OK: client and HPA timeline rows share even-second UTC timestamps")
