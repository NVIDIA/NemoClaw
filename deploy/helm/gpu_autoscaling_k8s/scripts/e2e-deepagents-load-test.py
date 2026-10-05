#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
Deep Agents Code + NIM client: N end users send prompts into N OpenShell sandboxes.
Default N is E2E_USERS=3 (one sandbox per user). GPU inference is NIM.

Run agentscaling_deepagents_gpuutil.sh or agentscaling_deepagents_latency.sh first.
This module is started by ./scripts/client_deepagents.sh.
The client does not set the HPA metric.
Each user talks only to its sandbox (dcode -n). 1:1 mapping.
dcode -n does not need the Deep Agents gateway on :8642.

    openshell sandbox exec -n deepagent-nim-e2e-NNNN -- dcode -n "..."

The agent inside the sandbox then calls https://inference.local (Envoy → NIM HPA).
This is not files/load-generator.ts (that Job POSTs chat/completions at pod IPs).
This is not in-sandbox curl to inference.local.
This is not the OpenClaw e2e (chat.send on :18789).

Usage:
    E2E_USERS=5 ./scripts/client_deepagents.sh
Deep Agents has no HTTP dashboard.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
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

# GPU util keeps long answers. Latency (MAX_TOKENS<=128) uses one-sentence
# prompts so chats stay under ~10s.
try:
    _MAX_TOKENS = int(os.environ.get("MAX_TOKENS") or "2048")
except ValueError:
    _MAX_TOKENS = 2048
if _MAX_TOKENS <= 128:
    PROMPTS = [
        "Do not use tools. In one sentence, what is Kubernetes HPA?",
        "Do not use tools. In one sentence, what is GPU utilization?",
        "Do not use tools. In one sentence, what is NIM?",
    ]
else:
    PROMPTS = [
        "Do not use tools. Write a detailed 2000-word explanation of Kubernetes HPA and GPU autoscaling, with formulas, examples, and a step-by-step walkthrough. Keep writing until the answer is long.",
        "Do not use tools. Write a detailed 2000-word summary of transformer inference on NVIDIA GPUs, covering batching, KV cache, and tensor parallelism. Keep writing until the answer is long.",
        "Do not use tools. Write a detailed 2000-word description of how NIM serves models and batches concurrent chat requests, with examples. Keep writing until the answer is long.",
    ]


def sandbox_name(prefix: str, user_id: int) -> str:
    return f"{prefix}{user_id:04d}"


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


SANDBOX_NS = os.environ.get("OPENSHELL_NAMESPACE", "nemoclaw-sandboxes")


def stop_sandbox_chats(prefix: str, users: int) -> None:
    """Stop leftover dcode -n so chats cannot outlive client_deepagents.sh."""
    kubectl = shutil.which("kubectl")
    if not kubectl or users < 1:
        return
    print("Client finished: stopping in-sandbox dcode -n")
    for user_id in range(users):
        name = sandbox_name(prefix, user_id)
        try:
            subprocess.run(
                [
                    kubectl,
                    "exec",
                    "-n",
                    SANDBOX_NS,
                    name,
                    "-c",
                    "agent",
                    "--",
                    "bash",
                    "-c",
                    "pkill -TERM -f '[d]code -n' || true; sleep 1; pkill -KILL -f '[d]code -n' || true",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            continue


def estimate_tokens(text: str) -> int:
    """Reply-length estimate (~4 chars/token). dcode -n does not report usage."""
    if not text or not str(text).strip():
        return 0
    return max(1, len(str(text)) // 4)


def print_chat_table(
    results: list[dict[str, object]],
    duration_sec: int,
    inflight_start: int,
    inflight_per_user: int,
) -> None:
    rows: list[tuple[int, int, int, int]] = []
    for item in results:
        user_id = int(item.get("user_id") or 0)
        chats_ok = int(item.get("ok") or 0)
        chats_err = int(item.get("err") or 0)
        tokens = int(item.get("tokens") or 0)
        rows.append((user_id, chats_ok, chats_err, tokens))
    rows.sort(key=lambda row: row[0])
    all_err_zero = all(err == 0 for _, _, err, _tok in rows)
    err_note = "every sandbox returned replies with err=0" if all_err_zero else "per-user chat counts"
    print(
        f"Over {duration_sec}s ({inflight_start}→{inflight_per_user} inflight per user), {err_note}."
    )
    print("est. tokens ≈ reply length / 4 (dcode -n does not report usage).")
    print("")
    print(f"{'User':<8} {'Sandbox':<12} {'Successful chats':>16} {'err':>6} {'est. tokens':>12}")
    print(f"{'-' * 8} {'-' * 12} {'-' * 16} {'-' * 6} {'-' * 12}")
    total_ok = total_err = total_tok = 0
    for user_id, chats_ok, chats_err, tokens in rows:
        total_ok += chats_ok
        total_err += chats_err
        total_tok += tokens
        print(
            f"{'user ' + str(user_id):<8} {'sandbox ' + str(user_id):<12} "
            f"{chats_ok:>16} {chats_err:>6} {tokens:>12}"
        )
    print(f"{'-' * 8} {'-' * 12} {'-' * 16} {'-' * 6} {'-' * 12}")
    print(f"{'total':<8} {'':<12} {total_ok:>16} {total_err:>6} {total_tok:>12}")
    print("")
    print(
        "Path in use: user → OpenShell sandbox (dcode -n) → inference.local → "
        "Envoy load balancer → NIM."
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


async def send_user_query(sandbox: str, prompt: str, timeout_sec: int) -> tuple[bool, str]:
    """One end-user turn: prompt goes to the sandbox Deep Agents agent, not to Envoy."""
    openshell = shutil.which("openshell")
    if not openshell:
        return False, "openshell is not on PATH"
    proc = await asyncio.create_subprocess_exec(
        openshell,
        "sandbox",
        "exec",
        "-n",
        sandbox,
        "--no-tty",
        "--",
        "dcode",
        "-n",
        prompt,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        await terminate_proc(proc)
        return False, f"timed out after {timeout_sec}s"
    except asyncio.CancelledError:
        await terminate_proc(proc)
        raise
    stdout = stdout_b.decode("utf-8", errors="replace").strip()
    stderr = stderr_b.decode("utf-8", errors="replace").strip()
    combined = f"{stdout}\n{stderr}"
    if proc.returncode != 0:
        return False, stderr or stdout or f"exit {proc.returncode}"
    if FALLBACK_RE.search(combined):
        return False, "Deep Agents used embedded fallback instead of the managed gateway"
    if not stdout:
        return False, "empty Deep Agents response"
    return True, stdout


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
    """One dcode -n process per inflight slot.

    Inflight 2+ OOMed a CPU node. Default is one dcode -n per sandbox.
    """
    sandbox = sandbox_name(prefix, user_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    ok = 0
    err = 0
    tokens = 0
    started = time.monotonic()
    end = started + duration_sec
    escalate_at = started + 15
    turn = 0
    last_log = started
    log_handle = log_path.open("w")

    async def one_turn(turn_id: int) -> None:
        nonlocal ok, err, tokens, last_log
        prompt = PROMPTS[(user_id + turn_id) % len(PROMPTS)]
        success, detail = await send_user_query(sandbox, prompt, timeout_sec)
        if success:
            ok += 1
            ntok = estimate_tokens(detail)
            tokens += ntok
            log_handle.write(f"ok turn={turn_id} tokens={ntok}\n")
        else:
            err += 1
            log_handle.write(f"err turn={turn_id} {detail}\n")
            print(f"[user {user_id} sandbox {user_id}] turn {turn_id} error: {detail}", file=sys.stderr)
        now = time.monotonic()
        if now - last_log >= 15:
            print(
                f"[user {user_id} sandbox {user_id}] ok={ok} err={err} tokens={tokens}",
                flush=True,
            )
            last_log = now
        log_handle.flush()

    pending: set[asyncio.Task[None]] = set()
    try:
        while time.monotonic() < end and not stop_event.is_set():
            cap = inflight if time.monotonic() >= escalate_at else inflight_start
            while len(pending) < cap and time.monotonic() < end and not stop_event.is_set():
                pending.add(asyncio.create_task(one_turn(turn)))
                turn += 1
            if not pending:
                break
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    finally:
        log_handle.write(f"ok={ok} err={err} tokens={tokens}\n")
        log_handle.close()
    return {
        "user_id": user_id,
        "sandbox": sandbox,
        "ok": ok,
        "err": err,
        "tokens": tokens,
        "turns": turn,
        "duration": time.monotonic() - started,
        "log": str(log_path),
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
    print(f"  {args.users} end users → {args.users} Deep Agents (1:1)")
    print("  Each user sends chats to that user's sandbox.")
    print(f"  Concurrent chats per user: {args.inflight_start}→{args.inflight_per_user}")
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
            if current >= args.target_pods:
                if hold_started is None:
                    hold_started = time.monotonic()
                if time.monotonic() - hold_started >= args.hold_sec:
                    reached_target = True
                    print(
                        f"[load] {current} GPUs reached; stopping new chats "
                        "(in-flight replies will finish)",
                        file=sys.stderr,
                        flush=True,
                    )
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
    results: list[object] = []
    try:
        while True:
            if stop_load.is_set() or time.monotonic() >= deadline or all(t.done() for t in user_tasks):
                if time.monotonic() >= deadline and not stop_load.is_set():
                    print("[load] duration elapsed; stopping user queries", file=sys.stderr)
                stop_load.set()
                break
            await asyncio.sleep(1)

        results = list(await asyncio.gather(*user_tasks, return_exceptions=True))
    finally:
        stop_load.set()
        stop_sandbox_chats(args.prefix, args.users)
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
    tokens = sum(int(r.get("tokens") or 0) for r in results)
    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "path": "user -> sandbox dcode -n -> inference.local -> Envoy -> NIM HPA",
        "users": args.users,
        "target_pods": args.target_pods,
        "hpa_max_replicas": max_replicas,
        "reached_target": reached_target or max_replicas >= args.target_pods,
        "scale_down_ok": scale_down_ok,
        "successful_queries": successful,
        "failed_queries": failed,
        "estimated_tokens": tokens,
        "results": results,
    }
    summary_path = output_dir / f"summary_{args.users}users.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print_chat_table(results, args.duration, args.inflight_start, args.inflight_per_user)
    print(f"Wrote {summary_path}")
    if successful < 1:
        print("No successful user→sandbox Deep Agents queries.", file=sys.stderr)
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
        description="Deep Agents Code + NIM client: N users send dcode -n into N sandboxes; default E2E_USERS=3"
    )
    parser.add_argument("--users", type=int, default=int(os.environ.get("E2E_USERS", "3")))
    parser.add_argument("--prefix", default=os.environ.get("SANDBOX_PREFIX", "deepagent-nim-e2e-"))
    parser.add_argument("--output", default=os.environ.get("E2E_OUTPUT_DIR", "./e2e-results/deepagents"))
    parser.add_argument("--duration", type=int, default=int(os.environ.get("DURATION_SEC", "900")))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("E2E_PROMPT_TIMEOUT_SEC", "300")))
    parser.add_argument(
        "--inflight-per-user",
        type=int,
        default=int(os.environ.get("E2E_INFLIGHT_PER_USER", "1")),
        help="Max concurrent dcode -n prompts per sandbox. Default 1; inflight 2 OOMed dgx-19.",
    )
    parser.add_argument(
        "--inflight-start",
        type=int,
        default=int(os.environ.get("E2E_INFLIGHT_START_PER_USER", "1")),
        help="Bootstrap concurrent dcode -n prompts per sandbox before ramping",
    )
    parser.add_argument("--target-pods", type=int, default=int(os.environ.get("TARGET_PODS", "8")))
    parser.add_argument("--hold-sec", type=float, default=float(os.environ.get("MAX_REPLICAS_HOLD_SEC", "0")))
    parser.add_argument("--hpa-namespace", default=os.environ.get("NAMESPACE", "nemoclaw-gpu"))
    parser.add_argument("--hpa-name", default=os.environ.get("HPA_NAME", "nemoclaw-gpu-metrics-proxy"))
    parser.add_argument("--hpa-poll-sec", type=float, default=float(os.environ.get("SCALE_UP_POLL_SEC", "2")))
    parser.add_argument("--scale-down-wait-loops", type=int, default=int(os.environ.get("SCALE_DOWN_WAIT_LOOPS", "40")))
    args = parser.parse_args()
    if args.users < 1 or args.inflight_per_user < 1 or args.inflight_start < 1:
        print("--users, --inflight-per-user, and --inflight-start must be >= 1", file=sys.stderr)
        return 2
    if args.inflight_start > args.inflight_per_user:
        args.inflight_start = args.inflight_per_user
    try:
        return asyncio.run(run_test(args))
    except KeyboardInterrupt:
        stop_sandbox_chats(args.prefix, args.users)
        return 130


if __name__ == "__main__":
    sys.exit(main())
