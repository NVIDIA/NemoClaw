#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
Hermes v1 client: N end users send prompts into N NemoClaw v1 sandboxes.
GPU inference is the operator-owned GPU chart (vLLM or NIM) behind the HPA.

Derived from scripts/e2e-hermes-load-test.py. Only the transport differs.
v0 runs `openshell sandbox exec ... hermes -z` through the v0.0.85 gateway.
A v1 sandbox runs Fabric. Official operator invoke is v1-invoke.sh through the
OpenShell gateway after oidc. This load client is a development-profile bypass:

    kubectl exec -i POD -c agent -- /opt/fabric/bin/fabric-agent-ctl invoke \
        --agent assistant --runtime-id RUNTIME_ID --input -

Runtime ids come from the nemoclaw state directory (NEMOCLAW_V1_STATE_DIR).
Start it with ./scripts/v1-client-hermes.sh. The client does not set the HPA
metric. Inference stays on the GPU chart Service /v1, not inference.local.
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

_SCRIPT_DIR = Path(__file__).resolve().parent
# e2e_timeline.py lives in the recipe's scripts/ folder, two levels up.
for _dir in (_SCRIPT_DIR, _SCRIPT_DIR.parents[1] / "scripts"):
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))
import e2e_timeline as timeline

FALLBACK_RE = re.compile(
    r"EMBEDDED FALLBACK|\[agent/embedded\]|fallbackFrom[\": ]+gateway|transport[\": ]+embedded",
    re.IGNORECASE,
)

# GPU util keeps longer answers. Latency (MAX_TOKENS<=128) uses one-sentence
# prompts, a 3s pause, and staggered starts so 5 users do not queue to ~14s.
try:
    _MAX_TOKENS = int(os.environ.get("MAX_TOKENS") or "64")
except ValueError:
    _MAX_TOKENS = 1024
if _MAX_TOKENS <= 128:
    PROMPTS = [
        "In one sentence, what is Kubernetes HPA?",
        "In one sentence, what is GPU utilization?",
        "In one sentence, what is vLLM?",
    ]
else:
    PROMPTS = [
        "Explain Kubernetes HPA and GPU autoscaling in detail with examples.",
        "Write a long summary of transformer inference on NVIDIA GPUs.",
        "Describe how vLLM serves models and batches concurrent chat requests.",
    ]
# v0 OpenClaw client prefixes every prompt. llama3.2:3b otherwise emits
# ask_user/msg tool JSON and the Fabric invoke hits timeoutSeconds with {}.
if os.environ.get("V1_AGENT_KIND") == "openclaw":
    PROMPTS = [
        prompt if prompt.startswith("Do not use tools.") else f"Do not use tools. {prompt}"
        for prompt in PROMPTS
    ]


def sandbox_name(prefix: str, user_id: int) -> str:
    return f"{prefix}{user_id:04d}"


def _chat_pause_sec() -> float:
    raw = os.environ.get("E2E_CHAT_PAUSE_SEC")
    if raw is None or raw == "":
        return 0.0
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 0.0


async def _stagger_user_start(user_id: int, stop_event: asyncio.Event) -> None:
    raw = os.environ.get("E2E_USER_STAGGER_SEC")
    if raw is None or raw == "":
        per_user = 0.0
    else:
        try:
            per_user = max(0.0, float(raw))
        except ValueError:
            per_user = 0.0
    delay = per_user * user_id
    if delay <= 0:
        return
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=delay)
    except asyncio.TimeoutError:
        return


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


def hpa_stop_new_chats_at(target: int) -> int:
    """Stop new chats when current or desired replicas reach the demo target."""
    return max(1, int(target))


def hpa_replicas_reached_target(current: int, desired: int, target: int) -> bool:
    """True when HPA current or desired replicas reached the demo target. 0/0 is a failed poll."""
    return max(current, desired) >= target


def hpa_should_stop_new_chats(current: int, desired: int, target: int) -> bool:
    """True at 8 current or desired on an 8-GPU demo. 0/0 does not stop."""
    n = max(current, desired)
    if n < 1:
        return False
    return n >= hpa_stop_new_chats_at(target)


def should_stop_after_hold(
    at_target: bool,
    hold_sec: float,
    at_max_since: float | None,
    now: float,
) -> tuple[bool, float | None]:
    """After HPA hits 8, wait hold_sec before ending chats."""
    if not at_target:
        return False, None
    since = now if at_max_since is None else at_max_since
    wait = hold_sec if hold_sec > 0 else 0.0
    return (now - since) >= wait, since


SANDBOX_NS = os.environ.get("V1_NAMESPACE", "nemoclaw-v1-gpu-autoscaling")


def stop_sandbox_chats(prefix: str, users: int) -> None:
    """Nothing to stop: each fabric-agent-ctl invoke ends with its own timeout."""
    return


def estimate_tokens(text: str) -> int:
    """Reply-length estimate (~4 chars/token). Not the runtime's own usage count."""
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
    del duration_sec
    print(
        f"After HPA scaled up and back to 1 ({inflight_start}→{inflight_per_user} inflight per user). {err_note}."
    )
    print("est. tokens ≈ reply length / 4 (not the runtime usage count).")
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
        "Path in use: user → kubectl exec (development-profile bypass) → "
        "fabric-agent-ctl invoke (agent in a v1 sandbox) → "
        "GPU chart Service /v1 (Envoy / metrics-proxy) → vLLM or NIM."
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


def inference_model() -> str:
    """Chart vLLM id. Do not use hermes config set; that drifts the sealed hash."""
    model = os.environ.get(
        "INFERENCE_MODEL", "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8"
    ).strip()
    if not model or model.startswith("-"):
        raise SystemExit("INFERENCE_MODEL is missing or looks like a flag")
    return model


_RUNTIME_IDS: dict[str, str] | None = None


def runtime_ids() -> dict[str, str]:
    """Pod name (<workspace>--<sandbox>) -> Fabric runtime id, from the nemoclaw state directory."""
    global _RUNTIME_IDS
    if _RUNTIME_IDS is None:
        state_dir = os.environ.get("NEMOCLAW_V1_STATE_DIR")
        if not state_dir:
            raise SystemExit("Set NEMOCLAW_V1_STATE_DIR to the nemoclaw apply state directory")
        data = json.loads((Path(state_dir) / "terraform.tfstate").read_text())
        ids: dict[str, str] = {}
        for res in data.get("resources", []):
            if res.get("type") != "fabric_agent":
                continue
            for inst in res.get("instances", []):
                attrs = inst["attributes"]
                sb = attrs.get("sandbox") or {}
                if sb.get("name") and sb.get("workspace") and attrs.get("runtime_id"):
                    ids[f"{sb['workspace']}--{sb['name']}"] = attrs["runtime_id"]
        _RUNTIME_IDS = ids
    return _RUNTIME_IDS


def _reply_text(output: dict) -> str:
    """Agent answer from a Fabric invoke result. Adapters name the field differently."""
    for key in ("response", "final_response", "output_text", "text", "answer"):
        value = output.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for message in reversed(output.get("messages") or []):
        if isinstance(message, dict) and message.get("role") == "assistant":
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
    return ""


async def send_user_query(sandbox: str, prompt: str, timeout_sec: int) -> tuple[bool, str]:
    """One end-user turn: prompt goes to the sandbox Hermes agent through Fabric."""
    kubectl = shutil.which("kubectl")
    if not kubectl:
        return False, "kubectl is not on PATH"
    runtime_id = runtime_ids().get(sandbox)
    if not runtime_id:
        return False, f"no Fabric runtime id for {sandbox} in the state directory"
    agent = os.environ.get("V1_AGENT_NAME", "assistant")
    proc = await asyncio.create_subprocess_exec(
        kubectl, "exec", "-i", "-n", SANDBOX_NS, sandbox, "-c", "agent", "--",
        "/opt/fabric/bin/fabric-agent-ctl", "invoke",
        "--agent", agent, "--runtime-id", runtime_id, "--input", "-",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(json.dumps(prompt).encode()), timeout=timeout_sec
        )
    except asyncio.TimeoutError:
        await terminate_proc(proc)
        return False, f"timed out after {timeout_sec}s"
    except asyncio.CancelledError:
        await terminate_proc(proc)
        raise
    stdout = stdout_b.decode("utf-8", errors="replace").strip()
    stderr = stderr_b.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0 and not stdout:
        return False, stderr or f"exit {proc.returncode}"
    try:
        reply = json.loads(stdout)
    except json.JSONDecodeError:
        return False, f"unparseable fabric-agent-ctl output: {stdout[:200]}"
    result = reply.get("result") or {}
    output = result.get("output") or {}
    result_status = result.get("status")
    if reply.get("status") != "succeeded" or result_status != "succeeded":
        err = reply.get("error") or result.get("error") or {}
        return False, (
            f"fabric status={reply.get('status')} result_status={result_status} "
            f"code={err.get('code')} stage={err.get('stage')} "
            f"output_keys={sorted(output)}"
        )
    text = _reply_text(output)
    if output.get("completed") is False or not text:
        return False, "empty or incomplete agent response"
    return True, text


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
    """One hermes -z process per inflight slot.

    Inflight 2+ OOMed a CPU node. Default is one hermes -z per sandbox.
    """
    await _stagger_user_start(user_id, stop_event)
    if stop_event.is_set():
        return {"user_id": user_id, "sandbox": sandbox_name(prefix, user_id), "ok": 0, "err": 0, "chats_ok": 0, "chats_err": 0}
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
        nonlocal ok, err, tokens, last_log, runtime_gone
        if stop_event.is_set():
            return
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
            if "runtime_unavailable" in detail:
                runtime_gone = True
        now = time.monotonic()
        if now - last_log >= 15:
            print(
                f"[user {user_id} sandbox {user_id}] ok={ok} err={err} tokens={tokens}",
                flush=True,
            )
            last_log = now
        log_handle.flush()
        timeline.note_user(user_id, ok, err, tokens)
        pause = _chat_pause_sec()
        if pause > 0 and not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=pause)
            except asyncio.TimeoutError:
                pass  # Pause elapsed; stop_event was not set.

    pending: set[asyncio.Task[None]] = set()
    runtime_gone = False
    try:
        while time.monotonic() < end and not stop_event.is_set() and not runtime_gone:
            cap = inflight if time.monotonic() >= escalate_at else inflight_start
            while (
                len(pending) < cap
                and time.monotonic() < end
                and not stop_event.is_set()
                and not runtime_gone
            ):
                pending.add(asyncio.create_task(one_turn(turn)))
                turn += 1
            if not pending:
                break
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                exc = task.exception() if not task.cancelled() else None
                if exc is not None:
                    err += 1
                    print(
                        f"[user {user_id} sandbox {user_id}] {type(exc).__name__}: {exc}",
                        file=sys.stderr,
                    )
    finally:
        # Already-sent hermes -z must finish before any pkill.
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
            pending.clear()
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

    print("=" * 70)
    print(f"  {args.users} end users → {args.users} Hermes agents (1:1)")
    print("  Each user sends chats to that user's sandbox.")
    print(f"  Concurrent chats per user: {args.inflight_start}→{args.inflight_per_user}")
    print("=" * 70)
    stop_sandbox_chats(args.prefix, args.users)

    try:
        pinned_tokens = int(os.environ.get("MAX_TOKENS") or "64")
    except ValueError:
        pinned_tokens = 64
    print(
        f"[load] max_tokens={pinned_tokens} inflight={args.inflight_per_user}",
        flush=True,
    )

    async def poll_hpa() -> None:
        nonlocal max_replicas, reached_target
        at_max_since: float | None = None
        hold_announced = False
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
            if hpa_replicas_reached_target(current, desired, args.target_pods):
                reached_target = True
            at_stop = hpa_should_stop_new_chats(current, desired, args.target_pods)
            stop_now, at_max_since = should_stop_after_hold(
                at_stop, args.hold_sec, at_max_since, time.monotonic()
            )
            if stop_now:
                stop_load.set()
            elif at_stop and not hold_announced:
                hold_announced = True
                print(
                    f"[load] {hpa_stop_new_chats_at(args.target_pods)} GPUs — "
                    "stop new chats; already-sent chats keep running",
                    flush=True,
                )
            try:
                await asyncio.wait_for(stop_load.wait(), timeout=args.hpa_poll_sec)
            except asyncio.TimeoutError:
                continue

    poll_task = asyncio.create_task(poll_hpa())
    timeline.reset_counts()
    client_log = output_dir / "client-timeline.jsonl"
    client_log.write_text("")

    def write_client_tick() -> None:
        timeline.write_client(
            client_log,
            max_tokens=pinned_tokens,
            inflight=args.inflight_per_user,
            users=timeline.rows_for_users(args.users),
        )

    timeline_task = asyncio.create_task(timeline.tick_until(stop_load, write_client_tick))
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
        print("[load] already-sent chats finished", flush=True)
        stop_sandbox_chats(args.prefix, args.users)
    normalized: list[dict[str, object]] = []
    for item in results:
        if isinstance(item, dict):
            normalized.append(item)
        else:
            normalized.append({"error": str(item), "ok": 0, "err": 1})
    await poll_task
    await timeline_task

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

    successful = sum(int(r.get("ok") or 0) for r in normalized)
    failed = sum(int(r.get("err") or 0) for r in normalized)
    tokens = sum(int(r.get("tokens") or 0) for r in normalized)
    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "path": "user -> kubectl exec (development-profile bypass) -> fabric-agent-ctl invoke -> Hermes in v1 sandbox -> GPU chart Service /v1 -> vLLM HPA",
        "users": args.users,
        "target_pods": args.target_pods,
        "hpa_max_replicas": max_replicas,
        "reached_target": reached_target or max_replicas >= args.target_pods,
        "scale_down_ok": scale_down_ok,
        "successful_queries": successful,
        "failed_queries": failed,
        "estimated_tokens": tokens,
        "results": normalized,
    }
    summary_path = output_dir / f"summary_{args.users}users.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print_chat_table(normalized, args.duration, args.inflight_start, args.inflight_per_user)
    if successful < 1:
        print("No successful user→sandbox Hermes queries.", file=sys.stderr)
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
        description="Hermes + vLLM client: N users send hermes -z into N sandboxes; pass --users"
    )
    parser.add_argument("--users", type=int, required=True)
    parser.add_argument("--prefix", default=os.environ.get("SANDBOX_PREFIX", ""))
    parser.add_argument("--output", default=os.environ.get("E2E_OUTPUT_DIR", "./e2e-results/hermes-v1"))
    parser.add_argument("--duration", type=int, default=int(os.environ.get("DURATION_SEC", "900")))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("E2E_PROMPT_TIMEOUT_SEC", "180")))
    parser.add_argument(
        "--inflight-per-user",
        type=int,
        default=int(os.environ.get("E2E_INFLIGHT_PER_USER", "1")),
        help="Max concurrent chats per user on the one agent in that sandbox.",
    )
    parser.add_argument(
        "--inflight-start",
        type=int,
        default=int(os.environ.get("E2E_INFLIGHT_START_PER_USER", "1")),
        help="Bootstrap concurrent chats per user before ramping",
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
