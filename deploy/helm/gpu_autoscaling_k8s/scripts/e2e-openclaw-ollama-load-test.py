#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
OpenClaw + Ollama client: N end users send prompts into N CPU OpenClaw sandboxes.
Default N is E2E_USERS=5 (one sandbox per user). GPU inference is Ollama.

Run agentscaling_gpuutil.sh or agentscaling_latency.sh first. This module is started by ./scripts/client.sh.
The client does not set the HPA metric.
Each user talks only to its sandbox (:18789). 1:1 mapping.
Do not spawn `openclaw agent -m` (that starts a second Node CLI).

    openshell sandbox exec → chat.send on ws://127.0.0.1:18789/ws

The agent then calls https://inference.local (Envoy load balancer → Ollama HPA).
This is not files/load-generator.ts (that Job POSTs chat/completions at pod IPs).
This is not in-sandbox curl to inference.local.
Hermes + vLLM is a later e2e and is not this script.

Usage:
    E2E_USERS=5 python3 scripts/e2e-openclaw-ollama-load-test.py
    python3 scripts/e2e-openclaw-ollama-load-test.py --users 5
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import csv
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

FALLBACK_RE = re.compile(
    r"EMBEDDED FALLBACK|\[agent/embedded\]|fallbackFrom[\": ]+gateway|transport[\": ]+embedded",
    re.IGNORECASE,
)

# Same synthetic questions as files/load-generator.ts (not short one-word chats).
PROMPTS = [
    "Explain Kubernetes HPA and GPU autoscaling in detail with examples.",
    "Write a long summary of transformer inference on NVIDIA GPUs.",
    "Describe how Ollama serves models and batches concurrent chat requests.",
]


HELPER_PATH = Path(__file__).resolve().parent.parent / "files" / "openclaw-e2e-ws-prompt.py"
_HELPER_B64 = ""
SANDBOX_NS = os.environ.get("OPENSHELL_NAMESPACE", "nemoclaw-sandboxes")


def sandbox_name(prefix: str, user_id: int) -> str:
    return f"{prefix}{user_id:04d}"


def helper_b64() -> str:
    global _HELPER_B64
    if not _HELPER_B64:
        _HELPER_B64 = base64.b64encode(HELPER_PATH.read_bytes()).decode("ascii")
    return _HELPER_B64


def read_hpa(namespace: str, name: str) -> tuple[int, int]:
    try:
        raw = subprocess.check_output(
            [
                "kubectl",
                "get",
                "hpa",
                name,
                "-n",
                namespace,
                "-o",
                "jsonpath={.status.currentReplicas} {.status.desiredReplicas}",
            ],
            text=True,
            timeout=10,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return 0, 0
    parts = raw.split()
    current = int(parts[0]) if parts and parts[0].isdigit() else 0
    desired = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    return current, desired


def hpa_motion(current: int, desired: int) -> str:
    if current < desired:
        return "scale-up"
    if current > desired:
        return "scale-down"
    return "hold"


def format_hpa_line(namespace: str, name: str, current: int, desired: int) -> str:
    return (
        f"[hpa] {hpa_motion(current, desired)} "
        f"{namespace}/{name} current={current} desired={desired}"
    )


async def terminate_proc(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=20)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()


async def simulate_user(
    user_id: int,
    prefix: str,
    inflight: int,
    inflight_start: int,
    duration_sec: int,
    timeout_sec: int,
    stop_event: asyncio.Event,
    log_path: Path,
) -> dict[str, object]:
    """One kubectl exec per sandbox. In-process threads keep inflight chats.

    Many parallel openshell/kubectl execs OOM-kill an undersized CPU sandbox (exit 137).
    """
    sandbox = sandbox_name(prefix, user_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    kubectl = shutil.which("kubectl")
    if not kubectl:
        return {"user_id": user_id, "sandbox": sandbox, "ok": 0, "err": 1, "error": "kubectl missing"}
    if not HELPER_PATH.is_file():
        return {"user_id": user_id, "sandbox": sandbox, "ok": 0, "err": 1, "error": f"missing {HELPER_PATH}"}
    script = (
        "set -euo pipefail; "
        "ns=''; "
        "for n in /run/netns/*; do [ -e \"$n\" ] || continue; ns=$n; break; done; "
        "[ -n \"$ns\" ] || { echo no-sandbox-netns >&2; exit 1; }; "
        "unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN || true; "
        "if [ -f /tmp/nemoclaw-proxy-env.sh ]; then . /tmp/nemoclaw-proxy-env.sh; fi; "
        "unset OPENCLAW_GATEWAY_TOKEN || true; "
        "export E2E_DURATION_SEC=\"$3\" E2E_INFLIGHT=\"$4\" E2E_INFLIGHT_MAX=\"$5\" "
        "E2E_PROMPT_TIMEOUT_SEC=\"$6\" E2E_SESSION_KEY=\"$7\" "
        "E2E_ESCALATE_INTERVAL_SEC=15 E2E_ESCALATE_FACTOR=0.35; "
        "echo \"$1\" | base64 -d | nsenter --net=\"$ns\" python3 -"
    )
    proc = await asyncio.create_subprocess_exec(
        kubectl,
        "exec",
        "-n",
        SANDBOX_NS,
        sandbox,
        "-c",
        "agent",
        "--",
        "bash",
        "-c",
        script,
        "bash",
        helper_b64(),
        "Say OK in one word.",
        str(duration_sec),
        str(inflight_start),
        str(inflight),
        str(timeout_sec),
        f"agent:main:{sandbox}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    log_handle = log_path.open("w")
    ok = 0
    err = 0
    started = time.monotonic()

    async def pump() -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace")
            log_handle.write(text)
            log_handle.flush()
            print(f"[user {user_id} sandbox {user_id}] {text.rstrip()}", flush=True)

    pump_task = asyncio.create_task(pump())
    try:
        while proc.returncode is None and not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
        if stop_event.is_set() and proc.returncode is None:
            await terminate_proc(proc)
        else:
            await proc.wait()
    finally:
        await pump_task
        log_handle.close()
    rc = proc.returncode if proc.returncode is not None else 1
    if rc == 0:
        ok = 1
    else:
        err = 1
    return {
        "user_id": user_id,
        "sandbox": sandbox,
        "ok": ok,
        "err": err,
        "turns": inflight,
        "duration": time.monotonic() - started,
        "log": str(log_path),
        "exit": rc,
    }


async def run_test(args: argparse.Namespace) -> int:
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    logs_dir = output_dir / "sandbox-logs"
    stop_load = asyncio.Event()
    hpa_rows: list[dict[str, object]] = []
    max_replicas = 0
    reached_target = False
    hold_started: float | None = None

    print("=" * 70)
    print("  E2E test: OpenClaw + Ollama")
    print(f"  {args.users} end users send requests to {args.users} OpenClaw sandboxes (1:1)")
    print(f"  {args.users} OpenClaw sandboxes run on CPU")
    print(f"  LLM (Ollama {args.model}) runs on GPUs")
    print("  When end-user demand increases, GPU HPA scales Ollama from 1 to 8 GPUs")
    print(f"  Labels: user 0 sandbox 0 … user {args.users - 1} sandbox {args.users - 1}")
    print("  Each user prompts that user's CPU sandbox on :18789")
    print("  Path: end user → OpenClaw sandbox → https://inference.local → Envoy load balancer → GPU Ollama HPA")
    print("  One kubectl exec per sandbox (in-process inflight). Not N execs, not load-generator.ts.")
    print(
        f"  Concurrent prompts per user: start={args.inflight_start} max={args.inflight_per_user} "
        "(1:1 user→sandbox :18789; this demo uses inflight 1→2 on 8Gi)"
    )
    print(f"  GPU inference model={args.model}  HPA {args.hpa_namespace}/{args.hpa_name}")
    print(f"  duration≤{args.duration}s  target replicas={args.target_pods}")
    print("=" * 70)

    async def poll_hpa() -> None:
        nonlocal max_replicas, reached_target, hold_started
        while not stop_load.is_set():
            current, desired = await asyncio.to_thread(read_hpa, args.hpa_namespace, args.hpa_name)
            max_replicas = max(max_replicas, current, desired)
            hpa_rows.append(
                {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "current_replicas": current,
                    "desired_replicas": desired,
                }
            )
            print(
                format_hpa_line(args.hpa_namespace, args.hpa_name, current, desired),
                flush=True,
            )
            if current >= args.target_pods:
                if hold_started is None:
                    hold_started = time.monotonic()
                    print(
                        f"[hpa] end-user demand scaled GPUs to {args.target_pods}; "
                        f"holding {args.hold_sec}s then stopping user queries"
                    )
                if time.monotonic() - hold_started >= args.hold_sec:
                    reached_target = True
                    stop_load.set()
                    return
            try:
                await asyncio.wait_for(stop_load.wait(), timeout=args.hpa_poll_sec)
            except asyncio.TimeoutError:
                continue

    poll_task = asyncio.create_task(poll_hpa())
    user_tasks = [
        asyncio.create_task(
            simulate_user(
                user_id=i,
                prefix=args.prefix,
                inflight=args.inflight_per_user,
                inflight_start=args.inflight_start,
                duration_sec=args.duration,
                timeout_sec=args.timeout,
                stop_event=stop_load,
                log_path=logs_dir / f"{sandbox_name(args.prefix, i)}.log",
            )
        )
        for i in range(args.users)
    ]

    deadline = time.monotonic() + args.duration + 30
    while True:
        if stop_load.is_set() or time.monotonic() >= deadline or all(t.done() for t in user_tasks):
            if time.monotonic() >= deadline and not stop_load.is_set():
                print("[load] duration elapsed; stopping user queries", file=sys.stderr)
            stop_load.set()
            break
        await asyncio.sleep(1)

    results = list(await asyncio.gather(*user_tasks, return_exceptions=True))
    normalized: list[dict[str, object]] = []
    for item in results:
        if isinstance(item, dict):
            normalized.append(item)
        else:
            normalized.append({"error": str(item), "ok": 0, "err": 1})
    results = normalized
    await poll_task

    scale_down_ok = False
    for _ in range(args.scale_down_wait_loops):
        current, desired = await asyncio.to_thread(read_hpa, args.hpa_namespace, args.hpa_name)
        hpa_rows.append(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "current_replicas": current,
                "desired_replicas": desired,
            }
        )
        print(format_hpa_line(args.hpa_namespace, args.hpa_name, current, desired))
        if current <= 1:
            scale_down_ok = True
            break
        await asyncio.sleep(15)

    csv_path = output_dir / f"hpa_{args.users}users.csv"
    with csv_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["timestamp", "current_replicas", "desired_replicas"])
        writer.writeheader()
        writer.writerows(hpa_rows)

    successful = sum(int(r.get("ok") or 0) for r in results)
    failed = sum(int(r.get("err") or 0) for r in results)
    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "path": "user -> OpenClaw sandbox -> inference.local -> Envoy -> Ollama HPA",
        "users": args.users,
        "target_pods": args.target_pods,
        "hpa_max_replicas": max_replicas,
        "reached_target": reached_target or max_replicas >= args.target_pods,
        "scale_down_ok": scale_down_ok,
        "successful_queries": successful,
        "failed_queries": failed,
        "results": results,
    }
    summary_path = output_dir / f"summary_{args.users}users.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Wrote {csv_path}")
    print(f"Wrote {summary_path}")
    print(
        f"HPA max={max_replicas} target={args.target_pods} "
        f"scale_up={'ok' if summary['reached_target'] else 'FAIL'} "
        f"scale_down={'ok' if scale_down_ok else 'FAIL'} "
        f"user→sandbox queries ok={successful} err={failed}"
    )
    if successful < 1:
        print("No successful user→sandbox OpenClaw queries.", file=sys.stderr)
        return 1
    if not summary["reached_target"]:
        print(
            f"HPA did not scale to {args.target_pods} replicas under user→sandbox load.",
            file=sys.stderr,
        )
        return 1
    if not scale_down_ok:
        print("HPA did not scale down to 1 replica after user queries stopped.", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="OpenClaw + Ollama client: N users send OpenClaw prompts into N sandboxes (not Envoy-direct); default E2E_USERS=5"
    )
    parser.add_argument("--users", type=int, default=int(os.environ.get("E2E_USERS", "5")))
    parser.add_argument("--prefix", default=os.environ.get("SANDBOX_PREFIX", "openclaw-ollama-e2e-"))
    parser.add_argument("--output", default=os.environ.get("E2E_OUTPUT_DIR", "./e2e-results/openclaw-ollama"))
    parser.add_argument("--model", default=os.environ.get("INFERENCE_MODEL", "llama3.2:3b"))
    parser.add_argument("--duration", type=int, default=int(os.environ.get("DURATION_SEC", "900")))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("E2E_PROMPT_TIMEOUT_SEC", "600")))
    parser.add_argument(
        "--inflight-per-user",
        type=int,
        default=int(os.environ.get("E2E_INFLIGHT_PER_USER", "2")),
        help="Max concurrent chats per sandbox. This DGX demo uses 2.",
    )
    parser.add_argument(
        "--inflight-start",
        type=int,
        default=int(os.environ.get("E2E_INFLIGHT_START_PER_USER", "1")),
        help="Bootstrap concurrent chats per sandbox before ramping",
    )
    parser.add_argument("--target-pods", type=int, default=int(os.environ.get("TARGET_PODS", "8")))
    parser.add_argument("--hold-sec", type=float, default=float(os.environ.get("MAX_REPLICAS_HOLD_SEC", "0")))
    parser.add_argument("--hpa-namespace", default=os.environ.get("NAMESPACE", "nemoclaw-gpu"))
    parser.add_argument("--hpa-name", default=os.environ.get("HPA_NAME", "nemoclaw-gpu-metrics-proxy"))
    parser.add_argument("--hpa-poll-sec", type=float, default=float(os.environ.get("SCALE_UP_POLL_SEC", "10")))
    parser.add_argument("--scale-down-wait-loops", type=int, default=int(os.environ.get("SCALE_DOWN_WAIT_LOOPS", "40")))
    args = parser.parse_args()
    if args.users < 1 or args.inflight_per_user < 1 or args.inflight_start < 1:
        print("--users, --inflight-per-user, and --inflight-start must be >= 1", file=sys.stderr)
        return 2
    if args.inflight_start > args.inflight_per_user:
        args.inflight_start = args.inflight_per_user
    return asyncio.run(run_test(args))


if __name__ == "__main__":
    sys.exit(main())
