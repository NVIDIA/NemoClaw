#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""One query to the already-running OpenClaw agent on :18789. No extra Node."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


def _mask(payload: bytes, opcode: int = 1) -> bytes:
    key = os.urandom(4)
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", n))
    header.extend(key)
    return bytes(header) + bytes(b ^ key[i % 4] for i, b in enumerate(payload))


def _recv_frames(sock: socket.socket, buf: bytearray) -> tuple[list[tuple[int, bytes]], bytearray]:
    out: list[tuple[int, bytes]] = []
    while True:
        if len(buf) < 2:
            return out, buf
        b1, b2 = buf[0], buf[1]
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        n = b2 & 0x7F
        idx = 2
        if n == 126:
            if len(buf) < 4:
                return out, buf
            n = struct.unpack("!H", buf[2:4])[0]
            idx = 4
        elif n == 127:
            if len(buf) < 10:
                return out, buf
            n = struct.unpack("!Q", buf[2:10])[0]
            idx = 10
        need = idx + (4 if masked else 0) + n
        if len(buf) < need:
            return out, buf
        if masked:
            key = buf[idx : idx + 4]
            idx += 4
            payload = bytes(buf[idx + i] ^ key[i % 4] for i in range(n))
        else:
            payload = bytes(buf[idx : idx + n])
        buf = buf[need:]
        out.append((opcode, payload))


def _text(message: object) -> str:
    if not isinstance(message, dict):
        return ""
    raw = message.get("text")
    if isinstance(raw, str):
        return raw
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
        return "\n".join(parts)
    return ""


def _gateway_token() -> str:
    # Connect-shell env can still hold the OpenShell-injected token from
    # sandbox create. After nemoclaw-start, the running gateway uses
    # gateway.auth.token in openclaw.json (rotated on each start).
    try:
        with open("/sandbox/.openclaw/openclaw.json", encoding="utf-8") as fh:
            cfg = json.load(fh)
        token = ((cfg.get("gateway") or {}).get("auth") or {}).get("token")
        if isinstance(token, str) and token.strip():
            return token.strip()
    except (OSError, json.JSONDecodeError):
        pass  # Missing or unreadable gateway config: fall back to the env token.
    return os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")


def _max_tokens() -> int:
    """MAX_TOKENS is the client flag. It selects the prompt; chat.send has no maxTokens."""
    try:
        raw = int(os.environ.get("MAX_TOKENS") or "2048")
    except ValueError:
        raw = 2048
    return max(8, raw)


def _latency_metric() -> bool:
    """Short-at-6 is latency only. GPU util keeps MAX_TOKENS until stop at 8."""
    return "latency" in (os.environ.get("HPA_METRIC") or "")


def _replica_count() -> int:
    """Live GPU count from discovery /hpa. 0/0 is treated as 1, not 8."""
    now = time.monotonic()
    cached = getattr(_replica_count, "_cache", None)
    if cached is not None and now - cached[0] < 2.0:
        return int(cached[1])
    host = os.environ.get("E2E_HPA_HOST") or "127.0.0.1"
    try:
        port = int(os.environ.get("E2E_DISCOVERY_PORT") or "18788")
    except ValueError:
        port = 18788
    n = 0
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/hpa", timeout=2) as resp:
            data = json.loads(resp.read().decode())
        if isinstance(data, dict):
            current = int(data.get("current") or 0)
            desired = int(data.get("desired") or 0)
            n = max(current, desired)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, TypeError, ValueError):
        n = 0
    if n < 1:
        try:
            raw = subprocess.check_output(
                [
                    "kubectl",
                    "get",
                    "hpa",
                    os.environ.get("HPA_NAME") or "nemoclaw-gpu-metrics-proxy",
                    "-n",
                    os.environ.get("NAMESPACE") or "nemoclaw-gpu",
                    "-o",
                    "jsonpath={.status.currentReplicas} {.status.desiredReplicas}",
                ],
                text=True,
                timeout=5,
                stderr=subprocess.DEVNULL,
            )
            parts = raw.split()
            current = int(parts[0]) if parts and parts[0].isdigit() else 0
            desired = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            n = max(current, desired)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError, ValueError):
            n = 0
    if n < 1:
        n = 1
    _replica_count._cache = (now, n)
    return n


def estimate_tokens(text: str) -> int:
    """Reply-length estimate (~4 chars/token). OpenClaw chat.send has no usage field."""
    if not text or not str(text).strip():
        return 0
    return max(1, len(str(text)) // 4)


def send_one(
    prompt: str,
    session: str,
    timeout: float,
    token: str,
    quiet: bool,
    stop_event: object | None = None,
) -> tuple[int, int]:
    port = int(os.environ.get("OPENCLAW_GATEWAY_PORT", "18789"))
    host = os.environ.get("OPENCLAW_GATEWAY_HOST", "127.0.0.1")
    origin = f"http://{host}:{port}"
    deadline = time.monotonic() + timeout
    checker = getattr(stop_event, "is_set", None)
    if callable(checker) and checker():
        return 2, 0
    sock = socket.create_connection((host, port), timeout=timeout)
    sock.settimeout(5)
    try:
        ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
        sock.sendall(
            (
                f"GET /ws HTTP/1.1\r\n"
                f"Host: {host}:{port}\r\n"
                f"Upgrade: websocket\r\n"
                f"Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {ws_key}\r\n"
                f"Sec-WebSocket-Version: 13\r\n"
                f"Origin: {origin}\r\n"
                f"\r\n"
            ).encode("ascii")
        )
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = sock.recv(4096)
            if not chunk:
                if not quiet:
                    print("websocket handshake closed", file=sys.stderr)
                return 1, 0
            header += chunk
        head, extra = header.split(b"\r\n\r\n", 1)
        if b"101" not in head.split(b"\r\n", 1)[0]:
            if not quiet:
                print(head.decode("utf-8", "replace"), file=sys.stderr)
            return 1, 0
        expect = base64.b64encode(
            hashlib.sha1((ws_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        if expect.encode() not in head:
            if not quiet:
                print("bad websocket accept", file=sys.stderr)
            return 1, 0

        buf = bytearray(extra)
        pending: dict[str, dict] = {}
        req_id = 0
        answer = ""

        def send_req(method: str, params: dict) -> str:
            nonlocal req_id
            req_id += 1
            rid = f"r{req_id}"
            sock.sendall(_mask(json.dumps({"type": "req", "id": rid, "method": method, "params": params}).encode()))
            pending[rid] = {}
            return rid

        send_req(
            "connect",
            {
                "minProtocol": 4,
                "maxProtocol": 4,
                "client": {
                    "id": "openclaw-control-ui",
                    "displayName": "openclaw-ollama-e2e",
                    "version": "e2e",
                    "platform": "linux",
                    "mode": "ui",
                    "instanceId": str(uuid.uuid4()),
                },
                "caps": ["tool-events"],
                "scopes": ["operator.read", "operator.write"],
                "auth": {"token": token},
            },
        )
        send_id = None
        delete_id = None
        chat_sent = False

        def _stop_requested() -> bool:
            checker = getattr(stop_event, "is_set", None)
            return bool(callable(checker) and checker())

        def _send_chat() -> str:
            nonlocal chat_sent
            chat_sent = True
            send_params = {
                "sessionKey": session,
                "message": prompt,
                "deliver": False,
                "timeoutMs": int(timeout * 1000),
                "idempotencyKey": str(uuid.uuid4()),
            }
            return send_req("chat.send", send_params)

        while time.monotonic() < deadline:
            # Stop new chats does not abort a chat.send that already went out.
            # That turn still waits for a final reply (ok) or timeout (err).
            if _stop_requested() and not chat_sent:
                return 2, 0
            try:
                chunk = sock.recv(65536)
            except TimeoutError:
                continue
            if not chunk:
                break
            buf.extend(chunk)
            frames, buf = _recv_frames(sock, buf)
            for opcode, payload in frames:
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    sock.sendall(_mask(payload, 0xA))
                    continue
                if opcode != 0x1:
                    continue
                try:
                    frame = json.loads(payload.decode())
                except json.JSONDecodeError:
                    continue
                if frame.get("type") == "res" and frame.get("id") in pending:
                    rid = frame["id"]
                    # Drop the previous turn on this worker key so OpenClaw
                    # does not queue hundreds of stalled embedded_run sessions.
                    if rid == delete_id and send_id is None:
                        pending.pop(rid, None)
                        if _stop_requested() and not chat_sent:
                            return 2, 0
                        send_id = _send_chat()
                        continue
                    if frame.get("ok") is False or frame.get("error"):
                        if not quiet:
                            print(json.dumps(frame.get("error") or frame), file=sys.stderr)
                        return 1, 0
                    pending.pop(rid, None)
                    if rid == "r1" and send_id is None and delete_id is None:
                        delete_id = send_req(
                            "sessions.delete",
                            {"sessionKey": session, "deleteTranscript": True},
                        )
                    payload_obj = frame.get("payload") or frame.get("result") or {}
                    text = _text(payload_obj.get("message") if isinstance(payload_obj, dict) else None)
                    if text.strip():
                        answer = text.strip()
                event = frame.get("event")
                event_payload = frame.get("payload") or {}
                if event == "chat":
                    text = _text(event_payload.get("message"))
                    if text.strip():
                        answer = text.strip()
                    if event_payload.get("state") == "final":
                        if answer:
                            if not quiet:
                                print(answer)
                            return 0, estimate_tokens(answer)
                        return 1, 0
        if not quiet:
            print("no reply from running OpenClaw agent", file=sys.stderr)
        return (1, 0) if chat_sent else (2, 0)
    finally:
        try:
            sock.close()
        except OSError:
            pass


def run_load(prompt: str, timeout: float, token: str) -> int:
    """Keep a small number of in-flight chats in one sandbox process.

    Hundreds of OpenClaw sessions in one 4Gi sandbox OOMKills the agent (CPU RAM).
    Default thread stacks are ~8MiB; shrink them before spawning workers.
    """
    import threading

    try:
        threading.stack_size(256 * 1024)
    except (ValueError, RuntimeError):
        pass  # Some libcs reject a custom stack size after threads have started.

    duration = float(os.environ.get("E2E_DURATION_SEC", "0"))
    start_n = max(1, int(os.environ.get("E2E_INFLIGHT", "1")))
    max_n = max(start_n, int(os.environ.get("E2E_INFLIGHT_MAX", str(start_n))))
    interval = float(os.environ.get("E2E_ESCALATE_INTERVAL_SEC", "15"))
    factor = float(os.environ.get("E2E_ESCALATE_FACTOR", "0.35"))
    session_base = os.environ.get("E2E_SESSION_KEY", "agent:main:e2e")
    env_max_tokens = _max_tokens()
    pause_raw = os.environ.get("E2E_CHAT_PAUSE_SEC")
    # Every prompt must say not to use tools. Tool calls (write/exec) occupy
    # inflight slots while GPUs sit at 0% and 1→8 stalls.
    long_prompts = [
        prompt
        or "Do not use tools. Write a detailed 2000-word explanation of Kubernetes HPA and GPU autoscaling, with formulas, examples, and a step-by-step walkthrough. Keep writing until the answer is long.",
        "Do not use tools. Write a detailed 2000-word summary of transformer inference on NVIDIA GPUs, covering batching, KV cache, and tensor parallelism. Keep writing until the answer is long.",
        "Do not use tools. Write a detailed 2000-word description of how Ollama serves models and batches concurrent chat requests, with examples. Keep writing until the answer is long.",
    ]
    short_prompts = [
        "Do not use tools. In one sentence, what is Kubernetes HPA?",
        "Do not use tools. In one sentence, what is GPU utilization?",
        "Do not use tools. In one sentence, what is Ollama?",
    ]
    medium_prompts = [
        prompt
        or "Do not use tools. In about 200 words, explain Kubernetes HPA and GPU autoscaling.",
        "Do not use tools. In about 200 words, explain GPU utilization for LLM inference.",
        "Do not use tools. In about 200 words, explain how Ollama serves chat requests.",
    ]

    def current_prompts_and_pause() -> tuple[list[str], float]:
        if pause_raw is None or pause_raw == "":
            pause = 0.0
        else:
            try:
                pause = max(0.0, float(pause_raw))
            except ValueError:
                pause = 0.0
        if _latency_metric() and _replica_count() >= 6:
            return short_prompts, pause
        if env_max_tokens <= 128:
            return short_prompts, pause
        if env_max_tokens <= 1024:
            return medium_prompts, pause
        return long_prompts, pause
    stop = threading.Event()
    ok = 0
    err = 0
    tokens = 0
    lock = threading.Lock()
    workers: list[threading.Thread] = []

    def send_or_retry(text: str, session: str) -> tuple[int, int]:
        # One retry covers Envoy/Ollama blips while HPA adds or removes pods.
        # Do not start a send after SIGTERM / duration stop. A chat already
        # sent still waits for a final reply.
        if stop.is_set():
            return 2, 0
        for attempt in (0, 1):
            try:
                rc, ntok = send_one(text, session, timeout, token, quiet=True, stop_event=stop)
            except (TimeoutError, OSError, ConnectionError):
                rc, ntok = 1, 0
            if rc == 0:
                return 0, ntok
            if rc == 2:
                return 2, 0
            if attempt == 0 and not stop.is_set():
                time.sleep(2)
        return 1, 0

    def worker(wid: int) -> None:
        nonlocal ok, err, tokens
        turn = 0
        while not stop.is_set():
            prompts, pause = current_prompts_and_pause()
            text = prompts[(wid + turn) % len(prompts)]
            session = f"{session_base}:w{wid}"
            rc, ntok = send_or_retry(text, session)
            with lock:
                if rc == 0:
                    ok += 1
                    tokens += ntok
                elif rc == 2:
                    # Never sent: stop-new-chats, not a failed chat.
                    pass
                else:
                    err += 1
            turn += 1
            remaining = pause
            while remaining > 0 and not stop.is_set():
                step = min(0.25, remaining)
                time.sleep(step)
                remaining -= step

    def spawn_upto(n: int) -> None:
        while len(workers) < n:
            wid = len(workers)
            t = threading.Thread(target=worker, args=(wid,), name=f"e2e-w{wid}", daemon=True)
            workers.append(t)
            t.start()

    def request_stop(_signum: int | None = None, _frame: object = None) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    spawn_upto(start_n)
    print(
        f"[load] start inflight={start_n} max={max_n} MAX_TOKENS={env_max_tokens}",
        flush=True,
    )
    deadline = time.monotonic() + duration
    last = time.monotonic()
    last_log = last
    current = start_n

    while time.monotonic() < deadline and not stop.is_set():
        now = time.monotonic()
        if now - last >= interval and current < max_n:
            add = max(1, int(current * factor))
            current = min(max_n, current + add)
            last = now
            spawn_upto(current)
            print(f"[load] escalate inflight={current} ok={ok} err={err} tokens={tokens}", flush=True)
        if now - last_log >= 15:
            print(f"[load] inflight={current} ok={ok} err={err} tokens={tokens}", flush=True)
            last_log = now
        time.sleep(0.5)
    stop.set()
    # Wait for already-sent chats to get a final reply (or timeout). Those
    # counts are ok (got a reply) or err (sent, no reply).
    drain = float(
        os.environ.get("E2E_DRAIN_SEC")
        or os.environ.get("E2E_PROMPT_TIMEOUT_SEC")
        or str(timeout)
    )
    join_deadline = time.monotonic() + max(0.0, drain)
    for worker_thread in workers:
        remaining = max(0.0, join_deadline - time.monotonic())
        worker_thread.join(timeout=remaining)
    print(f"[load] done inflight={current} ok={ok} err={err} tokens={tokens}", flush=True)
    return 0 if ok > 0 else 1


def main() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else ""
    duration = float(os.environ.get("E2E_DURATION_SEC", "0") or "0")
    if duration <= 0 and not prompt:
        print("missing prompt", file=sys.stderr)
        return 2
    token = _gateway_token()
    timeout = float(os.environ.get("E2E_PROMPT_TIMEOUT_SEC", "120"))
    if duration > 0:
        return run_load(prompt, timeout, token)
    session = os.environ.get("E2E_SESSION_KEY", "agent:main:e2e")
    rc, _tokens = send_one(prompt, session, timeout, token, quiet=False)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
