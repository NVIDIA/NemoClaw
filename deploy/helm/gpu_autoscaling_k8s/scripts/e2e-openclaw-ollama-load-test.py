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

    client host → published :18789+i WebSocket chat.send
    (laptop: E2E_CLIENT_HOST=dgx-ip; same DGX: --host 127.0.0.1)

The agent then calls https://inference.local (Envoy load balancer → Ollama HPA).
This is not files/load-generator.ts (that Job POSTs chat/completions at pod IPs).
This is not in-sandbox curl to inference.local.
This does not copy a load helper into the sandbox. Leftover e2e-openclaw-load
processes inside sandboxes are killed at start and stop so they cannot scale HPA.
Hermes + vLLM is a later e2e and is not this script.

Usage (laptop HTTP):
    E2E_CLIENT_HOST=dgx-ip E2E_USERS=5 ./scripts/client.sh
    python3 scripts/e2e-openclaw-ollama-load-test.py --host dgx-ip --chat-only
Do not install OpenShell on the laptop.
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
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))
import e2e_latency_load_ramp as latency_ramp

FALLBACK_RE = re.compile(
    r"EMBEDDED FALLBACK|\[agent/embedded\]|fallbackFrom[\": ]+gateway|transport[\": ]+embedded",
    re.IGNORECASE,
)
LOAD_COUNTS_RE = re.compile(r"\[load\].*\bok=(\d+)\s+err=(\d+)(?:\s+tokens=(\d+))?")
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
SANDBOX_NS = os.environ.get("OPENSHELL_NAMESPACE", "nemoclaw-sandboxes")


def sandbox_name(prefix: str, user_id: int) -> str:
    return f"{prefix}{user_id:04d}"


def load_endpoints(path: Path) -> list[dict[str, object]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    users = data.get("users") if isinstance(data, dict) else None
    if not isinstance(users, list) or not users:
        raise ValueError(f"{path} has no users[]")
    return users


def users_from_http_host(host: str, users: int, discovery_port: int) -> list[dict[str, object]]:
    """Resolve M agents at host:18789+i. Auth is fetched over HTTP; not a user file."""
    url = f"http://{host}:{discovery_port}/clients"
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        rows = data.get("users") if isinstance(data, dict) else None
        if isinstance(rows, list) and rows:
            return rows
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
        # Discovery is optional. Fall back to host:18789+i without a token file.
        pass
    return [
        {
            "user_id": i,
            "sandbox": sandbox_name("openclaw-ollama-e2e-", i),
            "ws_host": host,
            "ws_port": 18789 + i,
            "host": host,
            "token": os.environ.get("OPENCLAW_GATEWAY_TOKEN", ""),
        }
        for i in range(users)
    ]


def endpoint_for_user(users: list[dict[str, object]], user_id: int) -> dict[str, object]:
    for item in users:
        if int(item.get("user_id") or -1) == user_id:
            return item
    if user_id < len(users):
        return users[user_id]
    raise KeyError(f"no endpoint for user {user_id}")


def load_prompt() -> str:
    if os.environ.get("E2E_LATENCY_RAMP") == "1":
        return latency_ramp.prompt_for_tokens(latency_ramp.token_bands()[0], "openclaw")[0]
    try:
        max_tokens = int(os.environ.get("MAX_TOKENS") or "2048")
    except ValueError:
        max_tokens = 1024
    if max_tokens <= 128:
        return "In one sentence, what is Kubernetes HPA?"
    return (
        "Write a detailed 2000-word explanation of Kubernetes HPA and GPU autoscaling, "
        "with formulas, examples, and a step-by-step walkthrough. Keep writing until the answer is long."
    )


SANDBOX_RAMP_FILE = "/tmp/e2e-latency-ramp.json"


def clear_ramp_from_sandboxes(prefix: str, users: int) -> None:
    """Drop leftover latency stop files so GPU-util chats keep running."""
    kubectl = shutil.which("kubectl")
    if not kubectl or users < 1:
        return
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
                    "rm",
                    "-f",
                    SANDBOX_RAMP_FILE,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            continue


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
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return 0, 0
    parts = raw.split()
    current = int(parts[0]) if parts and parts[0].isdigit() else 0
    desired = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    return current, desired


def _hpa_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return 0


def hpa_replicas_reached_target(current: int, desired: int, target: int) -> bool:
    """True when HPA current or desired replicas reached the demo target. 0/0 is a failed poll."""
    return max(current, desired) >= target


def read_hpa_http_status(host: str, port: int) -> tuple[int, int, str]:
    url = f"http://{host}:{port}/hpa"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return 0, 0, ""
    if not isinstance(data, dict):
        return 0, 0, ""
    metric = data.get("metric")
    return (
        _hpa_int(data.get("current")),
        _hpa_int(data.get("desired")),
        metric if isinstance(metric, str) else "",
    )


def read_hpa_http(host: str, port: int) -> tuple[int, int]:
    current, desired, _metric = read_hpa_http_status(host, port)
    return current, desired


# Kill OpenClaw exec children (gateway-spawned bash/cat/sleep). Do not
# pkill -f shell-snapshots: kubectl exec uses that same bash wrapper.
KILL_LEFTOVER_OPENCLAW_EXEC = r"""
python3 -c '
# KILL_OPENCLAW_EXEC
import os, signal, pathlib

def ppid_of(pid):
    try:
        stat = (pathlib.Path("/proc") / str(pid) / "stat").read_text()
        return int(stat[stat.rfind(")") + 2 :].split()[1])
    except (OSError, IndexError, ValueError):
        return 0

self = os.getpid()
gateways = set()
for proc in pathlib.Path("/proc").iterdir():
    if not proc.name.isdigit():
        continue
    try:
        comm = (proc / "comm").read_text().strip()
        cmd = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        continue
    if "openclaw-gateway" in comm or "openclaw-gateway" in cmd:
        gateways.add(int(proc.name))

def spawned_by_gateway(pid):
    seen = set()
    cur = pid
    while cur > 1 and cur not in seen:
        if cur in gateways:
            return True
        seen.add(cur)
        cur = ppid_of(cur)
    return False

for proc in pathlib.Path("/proc").iterdir():
    if not proc.name.isdigit():
        continue
    pid = int(proc.name)
    if pid in (0, 1, self) or pid in gateways:
        continue
    try:
        comm = (proc / "comm").read_text().strip()
        cmd = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        continue
    if "KILL_OPENCLAW_EXEC" in cmd or "nemoclaw-start" in cmd:
        continue
    leftover = spawned_by_gateway(pid) or cmd.strip().startswith("sleep 10000") or cmd.strip().startswith("sleep 1000")
    if leftover:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
' || true
"""

# argv from exec -a. Also TERM leftover python3 that still has NEMOCLAW_E2E_LOAD=1.
TERM_SANDBOX_HELPERS = (
    r"""
pkill -TERM -f '[e]2e-openclaw-load' || true
pkill -TERM -f '[E]2E_ESCALATE_INTERVAL_SEC' || true
for env in /proc/[0-9]*/environ; do
  pid="${env#/proc/}"; pid="${pid%/environ}"
  if tr '\0' '\n' < "$env" 2>/dev/null | grep -qx 'NEMOCLAW_E2E_LOAD=1'; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
done
"""
    + KILL_LEFTOVER_OPENCLAW_EXEC
)
KILL_SANDBOX_HELPERS = (
    TERM_SANDBOX_HELPERS
    + r"""
sleep 1
pkill -KILL -f '[e]2e-openclaw-load' || true
pkill -KILL -f '[E]2E_ESCALATE_INTERVAL_SEC' || true
for env in /proc/[0-9]*/environ; do
  pid="${env#/proc/}"; pid="${pid%/environ}"
  if tr '\0' '\n' < "$env" 2>/dev/null | grep -qx 'NEMOCLAW_E2E_LOAD=1'; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
done
"""
    + KILL_LEFTOVER_OPENCLAW_EXEC
)

# Hermes stops leftover chats with `pkill hermes -z`. OpenClaw chat.send is
# inside the gateway (stream=false), so closing the client WS does not abort
# Ollama. SIGTERM `openclaw gateway run` drops that HTTP. client.sh then
# relaunches an idle gateway so :18789 comes back. Do not pkill nemoclaw-start
# here; setup start owns the relaunch.
INTERRUPT_OPENCLAW_INFLIGHT = r"""
pkill -TERM -f '[o]penclaw gateway run' || true
""" + KILL_LEFTOVER_OPENCLAW_EXEC


def _exec_sandbox_helper_signal(prefix: str, users: int, script: str, note: str) -> None:
    kubectl = shutil.which("kubectl")
    if not kubectl or users < 1:
        return
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
                    script,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            continue


def kill_sandbox_load_helpers(prefix: str, users: int) -> None:
    """SIGTERM then SIGKILL leftover e2e-openclaw-load inside sandboxes. Gateway stays up."""
    _exec_sandbox_helper_signal(
        prefix, users, KILL_SANDBOX_HELPERS, "stopping leftover in-sandbox chat helpers"
    )


def interrupt_openclaw_inflight(prefix: str, users: int) -> None:
    """Drop in-flight OpenClaw→Ollama calls so GPUs go idle after the client stops."""
    _exec_sandbox_helper_signal(
        prefix, users, INTERRUPT_OPENCLAW_INFLIGHT, "dropping in-flight OpenClaw completions"
    )


def stop_new_sandbox_chats(prefix: str, users: int) -> None:
    """SIGTERM in-sandbox helpers so they start no new chats."""
    _exec_sandbox_helper_signal(
        prefix,
        users,
        TERM_SANDBOX_HELPERS,
        "8 GPUs: SIGTERM in-sandbox helpers (no new chats)",
    )


def stop_sandbox_chats(prefix: str, users: int) -> None:
    """Kill leftover in-sandbox helpers and abort in-flight OpenClaw completions."""
    kill_sandbox_load_helpers(prefix, users)
    interrupt_openclaw_inflight(prefix, users)


def parse_load_counts(log_path: Path) -> tuple[int, int, int]:
    """Last [load] ok/err/tokens in the sandbox log is the chat count, not process exit."""
    ok = err = tokens = 0
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return 0, 0, 0
    for match in LOAD_COUNTS_RE.finditer(text):
        ok, err = int(match.group(1)), int(match.group(2))
        tokens = int(match.group(3) or 0)
    return ok, err, tokens


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
        chats_ok, chats_err, tokens = parse_load_counts(path)
        results.append(
            {
                "user_id": user_id,
                "sandbox": sandbox_name(prefix, user_id),
                "chats_ok": chats_ok,
                "chats_err": chats_err,
                "tokens": tokens,
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
    rows: list[tuple[int, int, int, int, str]] = []
    for item in results:
        user_id = int(item.get("user_id") or 0)
        log = item.get("log")
        chats_ok = int(item.get("chats_ok") or 0)
        chats_err = int(item.get("chats_err") or 0)
        tokens = int(item.get("tokens") or 0)
        if log and (chats_ok == 0 and chats_err == 0 and tokens == 0):
            chats_ok, chats_err, tokens = parse_load_counts(Path(str(log)))
        sandbox = str(item.get("sandbox") or sandbox_name("openclaw-ollama-e2e-", user_id))
        code = listener_http_code(sandbox) if check_listeners else "skip"
        rows.append((user_id, chats_ok, chats_err, tokens, code))
    all_err_zero = all(err == 0 for _, _, err, _tok, _ in rows)
    err_note = "every sandbox returned replies with err=0" if all_err_zero else "per-user chat counts"
    print(
        f"Over {duration_sec}s ({inflight_start}→{inflight_per_user} inflight per user), {err_note}."
    )
    print("est. tokens ≈ reply length / 4 (OpenClaw chat.send does not report usage).")
    print("")
    print(f"{'User':<8} {'Sandbox':<12} {'Successful chats':>16} {'err':>6} {'est. tokens':>12}")
    print(f"{'-' * 8} {'-' * 12} {'-' * 16} {'-' * 6} {'-' * 12}")
    total_ok = total_err = total_tok = 0
    for user_id, chats_ok, chats_err, tokens, _code in rows:
        total_ok += chats_ok
        total_err += chats_err
        total_tok += tokens
        print(
            f"{'user ' + str(user_id):<8} {'sandbox ' + str(user_id):<12} "
            f"{chats_ok:>16} {chats_err:>6} {tokens:>12}"
        )
    print(f"{'-' * 8} {'-' * 12} {'-' * 16} {'-' * 6} {'-' * 12}")
    print(f"{'total':<8} {'':<12} {total_ok:>16} {total_err:>6} {total_tok:>12}")
    path_line = (
        "Path in use: user → OpenShell sandbox :18789 → inference.local → "
        "Envoy load balancer → Ollama."
    )
    healthy = [code for _u, _ok, _err, _tok, code in rows]
    print("")
    if not check_listeners or all(code == "skip" for code in healthy):
        print(path_line)
    elif all(code == "200" for code in healthy):
        print(f"All {len(rows)} listeners are still 200. {path_line}")
    elif all(code in {"200", "401"} for code in healthy):
        print(f"All {len(rows)} listeners still answer /health. {path_line}")
    else:
        down = [f"sandbox {user_id}" for user_id, _ok, _err, _tok, code in rows if code not in {"200", "401"}]
        print(f"Listeners not 200 after load: {', '.join(down) if down else 'unknown'}")


async def terminate_proc(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=2)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()


async def stagger_user_start(user_id: int, stop_event: asyncio.Event) -> None:
    """Do not start all 5 users at t=0; that queues ~14s chats on 1 GPU."""
    try:
        max_tokens = int(os.environ.get("MAX_TOKENS") or "2048")
    except ValueError:
        max_tokens = 1024
    raw = os.environ.get("E2E_USER_STAGGER_SEC")
    if raw is None or raw == "":
        per_user = 0.0 if os.environ.get("E2E_LATENCY_RAMP") == "1" else (2.0 if max_tokens <= 128 else 0.0)
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


async def simulate_user_http(
    user_id: int,
    endpoint: dict[str, object],
    inflight: int,
    inflight_start: int,
    duration_sec: int,
    timeout_sec: int,
    stop_event: asyncio.Event,
    log_path: Path,
) -> dict[str, object]:
    """One local helper process per user. Talks WebSocket to the published host port."""
    sandbox = str(endpoint.get("sandbox") or sandbox_name("openclaw-ollama-e2e-", user_id))
    host = str(endpoint.get("ws_host") or endpoint.get("host") or "")
    port = int(endpoint.get("ws_port") or 0)
    token = str(endpoint.get("token") or "")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if not HELPER_PATH.is_file():
        return {"user_id": user_id, "sandbox": sandbox, "ok": 0, "err": 1, "error": f"missing {HELPER_PATH}"}
    if not host or port < 1 or not token:
        return {"user_id": user_id, "sandbox": sandbox, "ok": 0, "err": 1, "error": "endpoint missing host/port/token"}
    await stagger_user_start(user_id, stop_event)
    if stop_event.is_set():
        return {"user_id": user_id, "sandbox": sandbox, "ok": 0, "err": 0, "chats_ok": 0, "chats_err": 0}
    env = os.environ.copy()
    env["OPENCLAW_GATEWAY_HOST"] = host
    env["OPENCLAW_GATEWAY_PORT"] = str(port)
    env["OPENCLAW_GATEWAY_TOKEN"] = token
    env["NEMOCLAW_E2E_LOAD"] = "1"
    env["E2E_DURATION_SEC"] = str(duration_sec)
    env["E2E_INFLIGHT"] = str(inflight_start)
    env["E2E_INFLIGHT_MAX"] = str(inflight)
    env["E2E_PROMPT_TIMEOUT_SEC"] = str(timeout_sec)
    env["E2E_SESSION_KEY"] = f"agent:main:{sandbox}"
    env["E2E_ESCALATE_INTERVAL_SEC"] = "15"
    env["E2E_ESCALATE_FACTOR"] = "0.35"
    env["E2E_DRAIN_SEC"] = str(os.environ.get("E2E_DRAIN_SEC") or "0")
    env["MAX_TOKENS"] = str(os.environ.get("MAX_TOKENS") or "2048")
    env["E2E_LATENCY_RAMP"] = os.environ.get("E2E_LATENCY_RAMP") or "0"
    if env["E2E_LATENCY_RAMP"] == "1" and os.environ.get("E2E_LATENCY_RAMP_FILE"):
        env["E2E_LATENCY_RAMP_FILE"] = os.environ["E2E_LATENCY_RAMP_FILE"]
    if os.environ.get("E2E_CHAT_PAUSE_SEC"):
        env["E2E_CHAT_PAUSE_SEC"] = os.environ["E2E_CHAT_PAUSE_SEC"]
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(HELPER_PATH),
        load_prompt(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    log_handle = log_path.open("w")
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
            print(f"[user {user_id} sandbox {user_id} {host}:{port}] {text.rstrip()}", flush=True)

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
    chats_ok, chats_err, tokens = parse_load_counts(log_path)
    ok = 1 if chats_ok > 0 and (rc == 0 or stop_event.is_set()) else 0
    err = 0 if ok else 1
    return {
        "user_id": user_id,
        "sandbox": sandbox,
        "ok": ok,
        "err": err,
        "chats_ok": chats_ok,
        "chats_err": chats_err,
        "tokens": tokens,
        "turns": inflight,
        "duration": time.monotonic() - started,
        "log": str(log_path),
        "exit": rc,
        "cli_url": f"http://{host}:{port}",
    }


async def simulate_user(*_args: object, **_kwargs: object) -> dict[str, object]:
    """Removed: copying e2e-openclaw-load into the sandbox scaled GPUs after the client stopped."""
    raise RuntimeError(
        "OpenClaw client does not copy load helpers into sandboxes. Use --host."
    )


async def run_test(args: argparse.Namespace) -> int:
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    logs_dir = output_dir / "sandbox-logs"
    stop_load = asyncio.Event()
    hpa_rows: list[dict[str, object]] = []
    max_replicas = 0
    reached_target = False

    endpoints: list[dict[str, object]] = []
    if args.host:
        endpoints = users_from_http_host(args.host, args.users, args.discovery_port)
    elif args.endpoints:
        endpoints = load_endpoints(Path(args.endpoints))
    if not endpoints:
        print(
            "OpenClaw client must use --host (published :18789+i). "
            "It does not start in-sandbox load helpers.",
            file=sys.stderr,
        )
        return 2
    if args.users > len(endpoints):
        print(
            f"--users {args.users} but HTTP at {args.host or args.endpoints} has {len(endpoints)} users",
            file=sys.stderr,
        )
        return 2
    # Kill leftover in-sandbox helpers only. Do not restart the gateway here;
    # client.sh already reloaded it after the max_tokens pin.
    kill_sandbox_load_helpers(args.prefix, args.users)
    clear_ramp_from_sandboxes(args.prefix, args.users)

    print("=" * 70)
    print(f"  {args.users} end users → {args.users} OpenClaw agents (1:1)")
    print("  Path: client HTTP / WebSocket to published host ports.")
    for i in range(args.users):
        ep = endpoint_for_user(endpoints, i)
        print(
            f"  user {i} → {ep.get('sandbox')} "
            f"http://{ep.get('ws_host') or ep.get('host')}:{ep.get('ws_port')}"
        )
    print(f"  Concurrent chats per user: {args.inflight_start}→{args.inflight_per_user}")
    print("=" * 70)

    skip_hpa = bool(args.chat_only and not args.host)
    metric = ""
    if args.host:
        _current, _desired, metric = read_hpa_http_status(args.host, args.discovery_port)
    elif not skip_hpa:
        try:
            metric = subprocess.check_output(
                [
                    "kubectl",
                    "get",
                    "hpa",
                    args.hpa_name,
                    "-n",
                    args.hpa_namespace,
                    "-o",
                    "jsonpath={.spec.metrics[0].pods.metric.name}",
                ],
                text=True,
                timeout=10,
                stderr=subprocess.DEVNULL,
            ).strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
            metric = os.environ.get("HPA_METRIC", "")
    ramp_enabled = os.environ.get("E2E_LATENCY_RAMP") != "0"
    ramp_path = Path(os.environ.get("E2E_LATENCY_RAMP_FILE") or str(output_dir / "latency-ramp.json"))
    last_ramp_tokens: object = "unset"
    if ramp_enabled:
        os.environ["E2E_LATENCY_RAMP"] = "1"
        os.environ["E2E_LATENCY_RAMP_FILE"] = str(ramp_path)
        start_load = latency_ramp.scale_load(metric, 1, target=args.target_pods)
        start_tokens = latency_ramp.load_tokens(start_load) or latency_ramp.token_bands()[0]
        os.environ["MAX_TOKENS"] = str(start_tokens)
        os.environ["E2E_CHAT_PAUSE_SEC"] = os.environ.get("E2E_CHAT_PAUSE_SEC") or "0"
        os.environ["E2E_USER_STAGGER_SEC"] = os.environ.get("E2E_USER_STAGGER_SEC") or "0"
        latency_ramp.write_scale_load(start_load, ramp_path)
        last_ramp_tokens = start_tokens
        print(
            f"[load] max_tokens={start_tokens}; stop after hold at {args.target_pods} GPUs",
            flush=True,
        )

    async def poll_hpa() -> None:
        nonlocal max_replicas, reached_target, last_ramp_tokens
        at_max_since: float | None = None
        hold_announced = False
        while not stop_load.is_set():
            if args.host:
                current, desired = await asyncio.to_thread(
                    read_hpa_http, args.host, args.discovery_port
                )
            else:
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
            if ramp_enabled:
                load = latency_ramp.scale_load(
                    metric,
                    latency_ramp.effective_replicas(current, desired),
                    target=args.target_pods,
                )
                tokens = latency_ramp.load_tokens(load)
                stop_now, at_max_since = latency_ramp.should_stop_after_hold(
                    bool(load.get("stop")), args.hold_sec, at_max_since, time.monotonic()
                )
                if stop_now:
                    last_ramp_tokens = tokens
                    latency_ramp.write_scale_load(load, ramp_path)
                    stop_load.set()
                elif tokens is not None and tokens != last_ramp_tokens:
                    last_ramp_tokens = tokens
                    latency_ramp.write_scale_load(load, ramp_path)
                    print(f"[load] max_tokens={tokens}", flush=True)
                elif bool(load.get("stop")) and not hold_announced:
                    hold_announced = True
                    print(
                        f"[load] {args.target_pods} GPUs — hold {args.hold_sec:.0f}s then stop",
                        flush=True,
                    )
            try:
                await asyncio.wait_for(stop_load.wait(), timeout=args.hpa_poll_sec)
            except asyncio.TimeoutError:
                continue

    poll_task = None if skip_hpa else asyncio.create_task(poll_hpa())
    user_tasks = [
        asyncio.create_task(
            simulate_user_http(
                user_id=i,
                endpoint=endpoint_for_user(endpoints, i),
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
                print("[load] duration elapsed; stopping user queries", file=sys.stderr)
                stop_load.set()
                break
            await asyncio.sleep(1)

        results = list(await asyncio.gather(*user_tasks, return_exceptions=True))
    finally:
        stop_load.set()
        kill_sandbox_load_helpers(args.prefix, args.users)
        interrupt_openclaw_inflight(args.prefix, args.users)
    normalized: list[dict[str, object]] = []
    for item in results:
        if isinstance(item, dict):
            normalized.append(item)
        else:
            normalized.append({"error": str(item), "ok": 0, "err": 1})
    results = normalized
    if poll_task is not None:
        await poll_task

    scale_down_ok = False
    if skip_hpa:
        args.scale_down_wait_loops = 0
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
    chats_ok = sum(int(r.get("chats_ok") or 0) for r in results)
    chats_err = sum(int(r.get("chats_err") or 0) for r in results)
    tokens = sum(int(r.get("tokens") or 0) for r in results)
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
        "estimated_tokens": tokens,
        "results": results,
    }
    summary_path = output_dir / f"summary_{args.users}users.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print_chat_table(
        results,
        args.duration,
        args.inflight_start,
        args.inflight_per_user,
        check_listeners=not (args.chat_only or bool(endpoints)),
    )
    if successful < 1:
        print("No successful user→sandbox OpenClaw queries.", file=sys.stderr)
        return 1
    if args.chat_only or bool(endpoints):
        return 0
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
    parser.add_argument("--hold-sec", type=float, default=float(os.environ.get("MAX_REPLICAS_HOLD_SEC", "60")))
    parser.add_argument("--hpa-namespace", default=os.environ.get("NAMESPACE", "nemoclaw-gpu"))
    parser.add_argument("--hpa-name", default=os.environ.get("HPA_NAME", "nemoclaw-gpu-metrics-proxy"))
    parser.add_argument("--hpa-poll-sec", type=float, default=float(os.environ.get("SCALE_UP_POLL_SEC", "2")))
    parser.add_argument("--scale-down-wait-loops", type=int, default=int(os.environ.get("SCALE_DOWN_WAIT_LOOPS", "40")))
    parser.add_argument(
        "--from-logs",
        action="store_true",
        help="Print the chat table from --output sandbox-logs and exit. Does not send chat.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("E2E_CLIENT_HOST", ""),
        help="Published host for client HTTP (laptop: dgx-ip; same DGX: 127.0.0.1).",
    )
    parser.add_argument(
        "--discovery-port",
        type=int,
        default=int(os.environ.get("E2E_DISCOVERY_PORT", "18788")),
    )
    parser.add_argument(
        "--endpoints",
        default=os.environ.get("E2E_ENDPOINTS", ""),
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--chat-only",
        action="store_true",
        help="Send chats only. Do not fail if this machine cannot watch HPA.",
    )
    args = parser.parse_args()
    args.chat_only = bool(args.chat_only or os.environ.get("E2E_CHAT_ONLY") == "1")
    if args.endpoints == "":
        args.endpoints = None
    if args.host == "":
        args.host = None
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
    if not args.host and not args.endpoints:
        print(
            "OpenClaw client must use --host (published :18789+i). "
            "It does not start in-sandbox load helpers.",
            file=sys.stderr,
        )
        return 2
    try:
        return asyncio.run(run_test(args))
    except KeyboardInterrupt:
        stop_sandbox_chats(args.prefix, args.users)
        return 130


if __name__ == "__main__":
    sys.exit(main())
