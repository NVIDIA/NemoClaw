#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
OpenClaw + Ollama client: N end users send prompts into N OpenShell sandboxes.
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
LOAD_COUNTS_RE = re.compile(r"\[load\].*\bok=(\d+)\s+err=(\d+)\b")
LISTENER_HEALTH_SCRIPT = r"""
for ns in /run/netns/*; do
  [ -e "$ns" ] || continue
  code="$(nsenter --net="$ns" curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/health 2>/dev/null || true)"
  case "$code" in 200|401) echo "$code"; exit 0 ;; esac
done
echo down
exit 1
"""

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


# Marker in the in-sandbox kubectl exec. pkill this when client.sh exits so
# chats cannot outlive the host client.
LOAD_HELPER_PATTERN = "E2E_ESCALATE_INTERVAL_SEC"


def stop_sandbox_chats(prefix: str, users: int) -> None:
    """SIGTERM leftover OpenClaw load helpers inside sandboxes."""
    kubectl = shutil.which("kubectl")
    if not kubectl or users < 1:
        return
    print("Client finished: stopping in-sandbox chat helpers")
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
                    f"pkill -TERM -f '[E]2E_ESCALATE_INTERVAL_SEC' || true; "
                    f"sleep 1; pkill -KILL -f '[E]2E_ESCALATE_INTERVAL_SEC' || true",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            continue


def parse_load_counts(log_path: Path) -> tuple[int, int]:
    """Last [load] ok/err in the sandbox log is the chat count, not process exit."""
    ok = err = 0
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return 0, 0
    for match in LOAD_COUNTS_RE.finditer(text):
        ok, err = int(match.group(1)), int(match.group(2))
    return ok, err


def listener_http_code(sandbox: str) -> str:
    kubectl = shutil.which("kubectl")
    if not kubectl:
        return "down"
    try:
        raw = subprocess.check_output(
            [
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
                LISTENER_HEALTH_SCRIPT,
            ],
            text=True,
            timeout=15,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return "down"
    code = raw.strip().splitlines()[-1] if raw.strip() else "down"
    return code if code in {"200", "401"} else "down"


def results_from_logs(output_dir: Path, prefix: str) -> list[dict[str, object]]:
    logs_dir = output_dir / "sandbox-logs"
    results: list[dict[str, object]] = []
    user_id = 0
    while True:
        path = logs_dir / f"{sandbox_name(prefix, user_id)}.log"
        if not path.is_file():
            break
        chats_ok, chats_err = parse_load_counts(path)
        results.append(
            {
                "user_id": user_id,
                "sandbox": sandbox_name(prefix, user_id),
                "chats_ok": chats_ok,
                "chats_err": chats_err,
                "log": str(path),
            }
        )
        user_id += 1
    return results


def print_chat_table(
    results: list[dict[str, object]],
    duration_sec: int,
    inflight_start: int,
    inflight_per_user: int,
    check_listeners: bool = True,
) -> None:
    rows: list[tuple[int, int, int, str]] = []
    for item in results:
        user_id = int(item.get("user_id") or 0)
        log = item.get("log")
        chats_ok = int(item.get("chats_ok") or 0)
        chats_err = int(item.get("chats_err") or 0)
        if log and (chats_ok == 0 and chats_err == 0):
            chats_ok, chats_err = parse_load_counts(Path(str(log)))
        sandbox = str(item.get("sandbox") or sandbox_name("openclaw-ollama-e2e-", user_id))
        code = listener_http_code(sandbox) if check_listeners else "skip"
        rows.append((user_id, chats_ok, chats_err, code))
    all_err_zero = all(err == 0 for _, _, err, _ in rows)
    err_note = "every sandbox returned replies with err=0" if all_err_zero else "per-sandbox chat counts"
    print(
        f"Over {duration_sec}s ({inflight_start}→{inflight_per_user} inflight per user), {err_note}:"
    )
    print("")
    print(f"{'User':<8} {'Sandbox':<12} {'Successful chats':>16} {'err':>6}")
    print(f"{'-' * 8} {'-' * 12} {'-' * 16} {'-' * 6}")
    for user_id, chats_ok, chats_err, _code in rows:
        print(f"{'user ' + str(user_id):<8} {'sandbox ' + str(user_id):<12} {chats_ok:>16} {chats_err:>6}")
    path_line = (
        "Path in use: user → OpenShell sandbox :18789 → inference.local → "
        "Envoy load balancer → Ollama."
    )
    healthy = [code for _u, _ok, _err, code in rows]
    print("")
    if not check_listeners or all(code == "skip" for code in healthy):
        print(path_line)
    elif all(code == "200" for code in healthy):
        print(f"All {len(rows)} listeners are still 200. {path_line}")
    elif all(code in {"200", "401"} for code in healthy):
        print(f"All {len(rows)} listeners still answer /health. {path_line}")
    else:
        down = [f"sandbox {user_id}" for user_id, _ok, _err, code in rows if code not in {"200", "401"}]
        print(f"Listeners not 200 after load: {', '.join(down) if down else 'unknown'}")


async def terminate_proc(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=60)
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
        "export NEMOCLAW_E2E_LOAD=1 E2E_DURATION_SEC=\"$3\" E2E_INFLIGHT=\"$4\" E2E_INFLIGHT_MAX=\"$5\" "
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
        "Write a detailed 2000-word explanation of Kubernetes HPA and GPU autoscaling, with formulas, examples, and a step-by-step walkthrough. Keep writing until the answer is long.",
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
    chats_ok, chats_err = parse_load_counts(log_path)
    # run_test stops load early (HPA target or deadline) and SIGTERM the exec.
    # Count the user from chat.send results, not from the killed process exit code.
    if chats_ok > 0 and (rc == 0 or stop_event.is_set()):
        ok = 1
    else:
        err = 1
    return {
        "user_id": user_id,
        "sandbox": sandbox,
        "ok": ok,
        "err": err,
        "chats_ok": chats_ok,
        "chats_err": chats_err,
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
    print(f"  {args.users} end users send requests to {args.users} OpenClaw agents (1:1)")
    print(f"  {args.users} OpenClaw agents run in {args.users} OpenShell sandboxes")
    print("  LLM runs on GPUs (model already pinned in each sandbox)")
    print("  When end-user demand increases, GPU HPA scales Ollama from 1 to 8 GPUs")
    print(f"  Labels: user 0 sandbox 0 … user {args.users - 1} sandbox {args.users - 1}")
    print("  Each user prompts that user's sandbox on :18789")
    print("  Path: end user → OpenShell sandbox → https://inference.local → Envoy load balancer → GPU Ollama HPA")
    print("  One kubectl exec per sandbox (in-process inflight). Not N execs, not load-generator.ts.")
    print(
        f"  Concurrent prompts per user: start={args.inflight_start} max={args.inflight_per_user} "
        "(1:1 user→sandbox :18789; default inflight 1 so CPU sandboxes do not OOM)"
    )
    print(
        f"  max_tokens={os.environ.get('MAX_TOKENS', '1024')}  "
        f"HPA {args.hpa_namespace}/{args.hpa_name} (model already pinned in each sandbox)"
    )
    print(f"  duration cap {args.duration}s; load stops when HPA current replicas reach {args.target_pods} (not when user count is {args.users})")
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
                        f"holding {args.hold_sec}s then dropping user queries"
                    )
                if time.monotonic() - hold_started >= args.hold_sec:
                    reached_target = True
                    stop_load.set()
                    await asyncio.to_thread(stop_sandbox_chats, args.prefix, args.users)
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
            if stop_load.is_set() or all(t.done() for t in user_tasks):
                break
            if time.monotonic() >= deadline and not stop_load.is_set():
                print(
                    f"[load] duration elapsed or still below {args.target_pods} GPUs; stopping user queries",
                    file=sys.stderr,
                )
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
    chats_ok = sum(int(r.get("chats_ok") or 0) for r in results)
    chats_err = sum(int(r.get("chats_err") or 0) for r in results)
    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "path": "user -> OpenShell sandbox -> inference.local -> Envoy -> Ollama HPA",
        "users": args.users,
        "target_pods": args.target_pods,
        "hpa_max_replicas": max_replicas,
        "reached_target": reached_target or max_replicas >= args.target_pods,
        "scale_down_ok": scale_down_ok,
        "successful_queries": successful,
        "failed_queries": failed,
        "successful_chats": chats_ok,
        "failed_chats": chats_err,
        "results": results,
    }
    summary_path = output_dir / f"summary_{args.users}users.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Wrote {csv_path}")
    print(f"Wrote {summary_path}")
    print_chat_table(results, args.duration, args.inflight_start, args.inflight_per_user)
    print(
        f"HPA max={max_replicas} target={args.target_pods} "
        f"scale_up={'ok' if summary['reached_target'] else 'FAIL'} "
        f"scale_down={'ok' if scale_down_ok else 'FAIL'} "
        f"user→sandbox chats ok={chats_ok} err={chats_err}"
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
    parser.add_argument("--duration", type=int, default=int(os.environ.get("DURATION_SEC", "900")))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("E2E_PROMPT_TIMEOUT_SEC", "600")))
    parser.add_argument(
        "--inflight-per-user",
        type=int,
        default=int(os.environ.get("E2E_INFLIGHT_PER_USER", "1")),
        help="Max concurrent chats per sandbox. Default 1; inflight 2 OOMed dgx-19.",
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
    parser.add_argument(
        "--from-logs",
        action="store_true",
        help="Print the chat table from --output sandbox-logs and exit. Does not send chat.",
    )
    args = parser.parse_args()
    if args.users < 1 or args.inflight_per_user < 1 or args.inflight_start < 1:
        print("--users, --inflight-per-user, and --inflight-start must be >= 1", file=sys.stderr)
        return 2
    if args.inflight_start > args.inflight_per_user:
        args.inflight_start = args.inflight_per_user
    if args.from_logs:
        output_dir = Path(args.output)
        results = results_from_logs(output_dir, args.prefix)
        if not results:
            print(f"No sandbox-logs under {output_dir / 'sandbox-logs'}", file=sys.stderr)
            return 2
        print_chat_table(
            results,
            args.duration,
            args.inflight_start,
            args.inflight_per_user,
            check_listeners=False,
        )
        return 0
    return asyncio.run(run_test(args))


if __name__ == "__main__":
    sys.exit(main())
