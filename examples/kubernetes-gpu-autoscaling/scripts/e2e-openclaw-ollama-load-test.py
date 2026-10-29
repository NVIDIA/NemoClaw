#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
OpenClaw + Ollama client: N end users send prompts into N OpenShell sandboxes.
N comes from --users. client.sh passes E2E_USERS. GPU inference is Ollama.

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
    python3 scripts/e2e-openclaw-ollama-load-test.py --host dgx-ip --users 5 --chat-only
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
import e2e_timeline as timeline

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
    """Resolve M agents at host:18789+i. Discovery never includes gateway tokens."""
    url = f"http://{host}:{discovery_port}/clients"
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        rows = data.get("users") if isinstance(data, dict) else None
        if isinstance(rows, list) and rows:
            # Discovery records the laptop address. --host is the address this
            # process can open. Same-DGX bring-up listens on 127.0.0.1 only.
            aligned: list[dict[str, object]] = []
            for index, row in enumerate(rows):
                if not isinstance(row, dict):
                    continue
                item = dict(row)
                raw_id = item.get("user_id", index)
                try:
                    user_index = int(raw_id)
                except (TypeError, ValueError):
                    user_index = index
                item["ws_host"] = host
                item["host"] = host
                item["ws_port"] = 18789 + user_index
                aligned.append(item)
            if aligned:
                return aligned[:users]
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
        raw = item.get("user_id")
        if raw is None:
            continue
        if int(raw) == user_id:
            return item
    if user_id < len(users):
        return users[user_id]
    raise KeyError(f"no endpoint for user {user_id}")


def load_prompt() -> str:
    try:
        max_tokens = int(os.environ.get("MAX_TOKENS") or "2048")
    except ValueError:
        max_tokens = 2048
    if max_tokens <= 128:
        return "Do not use tools. In one sentence, what is Kubernetes HPA?"
    if max_tokens <= 1024:
        return "Do not use tools. In about 200 words, explain Kubernetes HPA and GPU autoscaling."
    return (
        "Do not use tools. Write a detailed 2000-word explanation of Kubernetes HPA and GPU autoscaling, "
        "with formulas, examples, and a step-by-step walkthrough. Keep writing until the answer is long."
    )


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


def hpa_effective_replicas(current: int, desired: int) -> int:
    """0/0 is a failed poll, not 8 GPUs."""
    return max(current, desired)


def hpa_stop_new_chats_at(target: int) -> int:
    """Stop new chats when current or desired replicas reach the demo target."""
    return max(1, int(target))


def hpa_replicas_reached_target(current: int, desired: int, target: int) -> bool:
    """True when HPA current or desired replicas reached the demo target. 0/0 is a failed poll."""
    return hpa_effective_replicas(current, desired) >= target


def hpa_should_stop_new_chats(current: int, desired: int, target: int) -> bool:
    """True at 8 current or desired on an 8-GPU demo. 0/0 does not stop."""
    n = hpa_effective_replicas(current, desired)
    if n < 1:
        return False
    return n >= hpa_stop_new_chats_at(target)


def hpa_replicas_back_to_one(current: int, desired: int) -> bool:
    """True when HPA is idle at 1 GPU. 0/0 is a failed poll, not scale-down."""
    n = hpa_effective_replicas(current, desired)
    if n < 1:
        return False
    return n <= 1


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


def read_hpa_for_client(
    host: str | None,
    discovery_port: int,
    namespace: str,
    name: str,
) -> tuple[int, int]:
    """HTTP /hpa when it reports replicas. kubectl if that poll is 0/0."""
    if host:
        current, desired = read_hpa_http(host, discovery_port)
        if hpa_effective_replicas(current, desired) > 0:
            return current, desired
    return read_hpa(namespace, name)


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


def stop_new_sandbox_chats(prefix: str, users: int) -> None:
    """SIGTERM in-sandbox helpers so they start no new chats."""
    _exec_sandbox_helper_signal(
        prefix,
        users,
        TERM_SANDBOX_HELPERS,
        "8 GPUs: SIGTERM in-sandbox helpers (no new chats)",
    )


def stop_sandbox_chats(prefix: str, users: int) -> None:
    """Kill leftover in-sandbox helpers. Leave the OpenClaw agent running."""
    kill_sandbox_load_helpers(prefix, users)


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
    print(
        f"After HPA scaled up and back to 1 ({inflight_start}→{inflight_per_user} inflight per user)."
    )
    print("Successful chats = chats that got a reply. err = chats that were sent and got no reply.")
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


def resume_hpa_scale_down_for_demo(namespace: str, hpa_name: str) -> None:
    """Let 8→1 start as soon as new chats stop. Laptop without kubectl is a no-op."""
    script = Path(__file__).resolve().parent / "hpa-common.sh"
    if not script.is_file() or shutil.which("kubectl") is None:
        return
    completed = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1" && hpa_common_resume_hpa_scale_down "$2" "$3"; '
            "hpa_common_set_dcgm_peak_window 15 || true",
            "resume-hpa",
            str(script),
            namespace,
            hpa_name,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip()
        print(
            f"[load] could not resume HPA scale-down: {err or 'kubectl patch failed'}",
            file=sys.stderr,
            flush=True,
        )


async def terminate_proc(proc: asyncio.subprocess.Process, wait_sec: float = 2) -> None:
    if proc.returncode is not None:
        return
    proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), timeout=max(2.0, wait_sec))
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()


async def stagger_user_start(user_id: int, stop_event: asyncio.Event) -> None:
    """Optional per-user delay. Default 0 so 1→8 starts as soon as chats begin."""
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
    if not host or port < 1:
        return {"user_id": user_id, "sandbox": sandbox, "ok": 0, "err": 1, "error": "endpoint missing host/port"}
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
    env["E2E_DRAIN_SEC"] = str(os.environ.get("E2E_DRAIN_SEC") or timeout_sec)
    env["MAX_TOKENS"] = str(os.environ.get("MAX_TOKENS") or "2048")
    env["HPA_METRIC"] = os.environ.get("HPA_METRIC") or ""
    env["E2E_HPA_HOST"] = os.environ.get("E2E_HPA_HOST") or host
    if os.environ.get("E2E_DISCOVERY_PORT"):
        env["E2E_DISCOVERY_PORT"] = os.environ["E2E_DISCOVERY_PORT"]
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
            # SIGTERM: helper starts no new chats. Wait for already-sent replies.
            drain = float(os.environ.get("E2E_DRAIN_SEC") or timeout_sec)
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=max(1.0, drain))
            except asyncio.TimeoutError:
                await terminate_proc(proc, wait_sec=5.0)
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
    if args.host:
        os.environ["E2E_HPA_HOST"] = str(args.host)
    os.environ.setdefault("E2E_DISCOVERY_PORT", str(args.discovery_port))
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
    # Kill leftover in-sandbox helpers only. Do not restart OpenClaw.
    kill_sandbox_load_helpers(args.prefix, args.users)

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
    try:
        pinned_tokens = int(os.environ.get("MAX_TOKENS") or "2048")
    except ValueError:
        pinned_tokens = 2048
    print(
        f"[load] max_tokens={pinned_tokens} inflight={args.inflight_per_user}",
        flush=True,
    )

    async def poll_hpa() -> None:
        nonlocal max_replicas, reached_target
        at_max_since: float | None = None
        hold_announced = False
        while not stop_load.is_set():
            current, desired = await asyncio.to_thread(
                read_hpa_for_client,
                args.host,
                args.discovery_port,
                args.hpa_namespace,
                args.hpa_name,
            )
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
                await asyncio.to_thread(
                    resume_hpa_scale_down_for_demo,
                    args.hpa_namespace,
                    args.hpa_name,
                )
                stop_load.set()
            elif at_stop and not hold_announced:
                hold_announced = True
                print(
                    f"[load] {hpa_stop_new_chats_at(args.target_pods)} GPUs — "
                    "stop new chats; wait for replies, then for HPA back to 1",
                    flush=True,
                )
            try:
                await asyncio.wait_for(stop_load.wait(), timeout=args.hpa_poll_sec)
            except asyncio.TimeoutError:
                continue

    poll_task = None if skip_hpa else asyncio.create_task(poll_hpa())
    client_log = output_dir / "client-timeline.jsonl"
    client_log.write_text("")

    def write_client_tick() -> None:
        rows = []
        for i in range(args.users):
            log = logs_dir / f"{sandbox_name(args.prefix, i)}.log"
            ok, err, tok = parse_load_counts(log) if log.is_file() else (0, 0, 0)
            rows.append({"user": i, "ok": ok, "err": err, "tokens": tok})
        timeline.write_client(
            client_log,
            max_tokens=pinned_tokens,
            inflight=args.inflight_per_user,
            users=rows,
        )

    timeline_task = asyncio.create_task(timeline.tick_until(stop_load, write_client_tick))
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
        print("[load] already-sent chats finished", flush=True)
        kill_sandbox_load_helpers(args.prefix, args.users)
    normalized: list[dict[str, object]] = []
    for item in results:
        if isinstance(item, dict):
            normalized.append(item)
        else:
            normalized.append({"error": str(item), "ok": 0, "err": 1})
    if poll_task is not None:
        await poll_task
    await timeline_task

    scale_down_ok = False
    if args.scale_down_wait_loops > 0:
        resume_hpa_scale_down_for_demo(args.hpa_namespace, args.hpa_name)
        print(
            "[load] already-sent chats finished; waiting until HPA is back to 1 GPU",
            flush=True,
        )
        deadline_down = time.monotonic() + (args.scale_down_wait_loops * 15)
        while time.monotonic() < deadline_down:
            current, desired = await asyncio.to_thread(
                read_hpa_for_client,
                args.host,
                args.discovery_port,
                args.hpa_namespace,
                args.hpa_name,
            )
            hpa_rows.append(
                {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "current_replicas": current,
                    "desired_replicas": desired,
                }
            )
            if hpa_replicas_back_to_one(current, desired):
                scale_down_ok = True
                print("[load] HPA is back to 1 GPU", flush=True)
                break
            await asyncio.sleep(2)
        if not scale_down_ok:
            print(
                "[load] HPA was not back to 1 GPU before the wait limit; "
                "printing chats that already got a reply",
                flush=True,
            )

    csv_path = output_dir / f"hpa_{args.users}users.csv"
    with csv_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["timestamp", "current_replicas", "desired_replicas"])
        writer.writeheader()
        writer.writerows(hpa_rows)

    successful = sum(int(r.get("ok") or 0) for r in normalized)
    failed = sum(int(r.get("err") or 0) for r in normalized)
    chats_ok = sum(int(r.get("chats_ok") or 0) for r in normalized)
    chats_err = sum(int(r.get("chats_err") or 0) for r in normalized)
    tokens = sum(int(r.get("tokens") or 0) for r in normalized)
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
        "results": normalized,
    }
    summary_path = output_dir / f"summary_{args.users}users.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")
    print_chat_table(
        normalized,
        args.duration,
        args.inflight_start,
        args.inflight_per_user,
        check_listeners=not args.chat_only,
    )
    if successful < 1:
        print("No successful user→sandbox OpenClaw queries.", file=sys.stderr)
        return 1
    if args.chat_only:
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
        description="OpenClaw + Ollama client: N users send OpenClaw prompts into N sandboxes (not Envoy-direct); pass --users"
    )
    parser.add_argument("--users", type=int, required=True)
    parser.add_argument("--prefix", default=os.environ.get("SANDBOX_PREFIX", "openclaw-ollama-e2e-"))
    parser.add_argument("--output", default=os.environ.get("E2E_OUTPUT_DIR", "./e2e-results/openclaw-ollama"))
    parser.add_argument("--duration", type=int, default=int(os.environ.get("DURATION_SEC", "900")))
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("E2E_PROMPT_TIMEOUT_SEC", "600")))
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
