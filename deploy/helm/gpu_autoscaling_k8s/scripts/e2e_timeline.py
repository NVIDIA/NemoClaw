#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Aligned 2s UTC JSONL records for client load and HPA animation.

Client and HPA writers use the same even-second UTC timestamp so rows join
on ``ts``. Neither writer prints records.
"""

from __future__ import annotations

import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

INTERVAL_SEC = 2

_counts: dict[int, dict[str, int]] = {}


def aligned_epoch(now: float | None = None) -> int:
    epoch = int(now if now is not None else time.time())
    return epoch - (epoch % INTERVAL_SEC)


def aligned_ts(now: float | None = None) -> str:
    return datetime.fromtimestamp(aligned_epoch(now), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def seconds_until_next_tick(now: float | None = None) -> float:
    t = time.time() if now is None else now
    remainder = t % INTERVAL_SEC
    wait = INTERVAL_SEC - remainder
    if wait < 0.05:
        wait += INTERVAL_SEC
    return wait


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")


def reset_counts() -> None:
    _counts.clear()


def note_user(user_id: int, ok: int, err: int, tokens: int) -> None:
    _counts[int(user_id)] = {
        "user": int(user_id),
        "ok": int(ok),
        "err": int(err),
        "tokens": int(tokens),
    }


def rows_for_users(n: int) -> list[dict[str, int]]:
    rows: list[dict[str, int]] = []
    for i in range(n):
        rows.append(_counts.get(i, {"user": i, "ok": 0, "err": 0, "tokens": 0}))
    return rows


def write_client(
    path: Path,
    *,
    max_tokens: int | None,
    inflight: int,
    users: list[dict[str, int]],
    now: float | None = None,
) -> None:
    total_ok = sum(int(row.get("ok") or 0) for row in users)
    total_err = sum(int(row.get("err") or 0) for row in users)
    total_tokens = sum(int(row.get("tokens") or 0) for row in users)
    append_jsonl(
        path,
        {
            "ts": aligned_ts(now),
            "max_tokens": max_tokens,
            "inflight": inflight,
            "users": users,
            "total_ok": total_ok,
            "total_err": total_err,
            "total_tokens": total_tokens,
        },
    )


def quantity(raw: object) -> float | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        if text.endswith("m") and text[:-1].replace(".", "", 1).lstrip("-").isdigit():
            return float(text[:-1]) / 1000.0
        return float(text)
    except ValueError:
        return None


def _metric_parts(hpa: dict[str, Any]) -> tuple[str, float | None, float | None]:
    spec_metrics = (hpa.get("spec") or {}).get("metrics") or []
    current_metrics = (hpa.get("status") or {}).get("currentMetrics") or []
    if not spec_metrics:
        return "", None, None
    spec = spec_metrics[0] if isinstance(spec_metrics[0], dict) else {}
    pods = spec.get("pods") if isinstance(spec.get("pods"), dict) else {}
    metric = ""
    name = (pods.get("metric") or {}).get("name") if isinstance(pods.get("metric"), dict) else None
    if isinstance(name, str):
        metric = name
    target = pods.get("target") if isinstance(pods.get("target"), dict) else {}
    target_value = quantity(target.get("averageValue") or target.get("value"))
    current_value = None
    if current_metrics and isinstance(current_metrics[0], dict):
        cur_pods = current_metrics[0].get("pods") if isinstance(current_metrics[0].get("pods"), dict) else {}
        current = cur_pods.get("current") if isinstance(cur_pods.get("current"), dict) else {}
        current_value = quantity(current.get("averageValue") or current.get("value"))
    return metric, current_value, target_value


def hpa_record(namespace: str, name: str, now: float | None = None) -> dict[str, Any]:
    record: dict[str, Any] = {
        "ts": aligned_ts(now),
        "current_replicas": 0,
        "desired_replicas": 0,
        "min_replicas": 0,
        "max_replicas": 0,
        "metric": "",
        "current_value": None,
        "target_value": None,
    }
    try:
        raw = subprocess.check_output(
            ["kubectl", "get", "hpa", name, "-n", namespace, "-o", "json"],
            text=True,
            timeout=8,
            stderr=subprocess.DEVNULL,
        )
        hpa = json.loads(raw)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError, json.JSONDecodeError):
        return record
    if not isinstance(hpa, dict):
        return record
    spec = hpa.get("spec") if isinstance(hpa.get("spec"), dict) else {}
    status = hpa.get("status") if isinstance(hpa.get("status"), dict) else {}
    metric, current_value, target_value = _metric_parts(hpa)
    record.update(
        {
            "current_replicas": int(status.get("currentReplicas") or 0),
            "desired_replicas": int(status.get("desiredReplicas") or 0),
            "min_replicas": int(spec.get("minReplicas") or 0),
            "max_replicas": int(spec.get("maxReplicas") or 0),
            "metric": metric,
            "current_value": current_value,
            "target_value": target_value,
        }
    )
    return record


def write_hpa(path: Path, namespace: str, name: str, now: float | None = None) -> None:
    append_jsonl(path, hpa_record(namespace, name, now=now))


async def tick_until(stop_event: Any, write_fn: Any) -> None:
    import asyncio

    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=seconds_until_next_tick())
            return
        except asyncio.TimeoutError:
            try:
                write_fn()
            except Exception:
                continue
