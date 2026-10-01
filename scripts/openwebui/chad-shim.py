#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-shim — OpenAI-compatible HTTP shim around `openclaw agent`.
#
# Lives **inside** the OpenShell sandbox. Translates POST /v1/chat/completions
# into one `openclaw agent` invocation per turn so the reply benefits from the
# same gbrain context, network policies, action-gate, and premium routing that
# drive Chad's other channels.
#
# Reach it from the host:
#   ssh -fN -L 8901:localhost:8901 openshell-chad
# then in open-webui admin → Settings → Connections add OpenAI provider:
#   URL: http://host.docker.internal:8901/v1
#   Key: any non-empty placeholder
#
# Stdlib-only on purpose. The L7 trust boundary pins outbound HTTP by binary
# identity (/proc/self/exe), but this server only listens on localhost and
# spawns `openclaw` as a subprocess — no Python-side network calls.
#
# Operator routing:
#   When open-webui has ENABLE_FORWARD_USER_INFO_HEADERS=True, each request
#   carries X-OpenWebUI-User-{Email,Name,Id,Role} + X-OpenWebUI-Chat-Id. The
#   shim:
#     - uses chat-id as a stable session id (one openclaw session per chat)
#     - loads /sandbox/.openclaw-data/identities/<email-local-part>.md and
#       prepends it as a tagged operator-context block to the user message,
#       so the model sees who it's talking to and adapts.
#   Unknown operators get default.md. Anonymous (no headers) gets nothing.

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

PORT = int(os.environ.get("CHAD_SHIM_PORT", "8901"))
MODEL_ID = os.environ.get("CHAD_SHIM_MODEL_ID", "chad")
AGENT_ID = os.environ.get("CHAD_SHIM_AGENT", "main")
OPENCLAW_BIN = os.environ.get("OPENCLAW_BIN", "openclaw")
TIMEOUT_SEC = int(os.environ.get("CHAD_SHIM_TIMEOUT", "300"))
DEBUG_HEADERS = os.environ.get("CHAD_SHIM_DEBUG_HEADERS", "0") == "1"
IDENTITY_DIR = os.environ.get(
    "CHAD_SHIM_IDENTITY_DIR", "/sandbox/.openclaw-data/identities"
)
IDENTITY_MAX_BYTES = int(os.environ.get("CHAD_SHIM_IDENTITY_MAX_BYTES", "8000"))

# Operator allowlist — when set, ONLY these emails reach the full Chad agent;
# every other authenticated user gets a polite refusal. This protects the shared
# agent/gbrain even if a non-operator selects the `chad` model in the UI (a
# server-side guarantee, independent of OpenWebUI model ACLs — so Chad Lite users
# can keep seeing every NVIDIA model in the dropdown; only `chad` is gated).
#
# Resolution order (so it PERSISTS across shim restarts without launch-script
# edits, and operator emails stay OUT of the committed repo):
#   1. CHAD_OPERATOR_ALLOWLIST env (comma-separated), else
#   2. "CHAD_OPERATOR_ALLOWLIST" in credentials.json (string OR JSON list).
# UNSET/empty in both = allow everyone (backward-compatible; the gate is opt-in).
# Anonymous callers (no email header — direct API/health tooling) are always
# allowed.
def _load_operator_allowlist() -> set:
    # Resolution order (first non-empty wins). The file source is what makes the
    # gate durable: it does NOT depend on any launcher exporting an env var, so
    # every shim launch path (watchdog, backup/restore, setup) is gated alike.
    # It lives under the backed-up state dir, so chad-restore repopulates it
    # before the shim comes up after a /sandbox wipe. The watchdog also refreshes
    # it on each launch. Emails stay out of the committed repo (host creds →
    # watchdog → this file).
    #   1. CHAD_OPERATOR_ALLOWLIST env (comma-separated or JSON list), else
    #   2. CHAD_OPERATOR_ALLOWLIST in credentials.json (string or JSON list), else
    #   3. CHAD_OPERATOR_ALLOWLIST_FILE (comma/newline-separated emails).
    raw = os.environ.get("CHAD_OPERATOR_ALLOWLIST", "")
    if not raw:
        creds_path = os.environ.get("CHAD_CREDENTIALS", "/sandbox/.nemoclaw/credentials.json")
        try:
            with open(creds_path) as fh:
                raw = json.load(fh).get("CHAD_OPERATOR_ALLOWLIST", "") or ""
        except (OSError, json.JSONDecodeError, ValueError):
            raw = ""
    if not raw:
        allow_file = os.environ.get(
            "CHAD_OPERATOR_ALLOWLIST_FILE",
            "/sandbox/.openclaw-data/state/operator-allowlist",
        )
        try:
            with open(allow_file) as fh:
                # Ignore blank lines and # comments; accept commas or newlines.
                raw = ",".join(
                    ln.strip() for ln in fh
                    if ln.strip() and not ln.lstrip().startswith("#")
                )
        except OSError:
            raw = ""
    items = raw if isinstance(raw, list) else str(raw).split(",")
    return {str(e).strip().lower() for e in items if str(e).strip()}


OPERATOR_ALLOWLIST = _load_operator_allowlist()
# When an allowlist is set, anonymous (header-less) callers are denied the
# premium agent by default. Opt in to allowing them only for trusted
# local/dev direct-API testing.
ALLOW_ANON = os.environ.get("CHAD_SHIM_ALLOW_ANON", "").strip().lower() in ("1", "true", "yes")
DENY_MESSAGE = os.environ.get(
    "CHAD_SHIM_DENY_MESSAGE",
    "This assistant isn't available on your account. Please use the **Chad Lite** "
    "model for general help, or contact the operator if you need full access.",
)

# Cache identity file contents keyed by (path, mtime) so we don't re-read on
# every turn but DO pick up edits without restarting the shim.
_identity_cache: dict[str, tuple[float, str]] = {}


def _slug_from_email(email: str) -> str:
    """tantodefi@proton.me → 'tantodefi'. Restricted to a safe set to keep the
    path traversal-free even if a malicious header arrives."""
    local = (email or "").split("@", 1)[0].strip().lower()
    safe = re.sub(r"[^a-z0-9._-]", "", local)
    return safe[:64]


def _load_identity(slug: str) -> str:
    """Read identity file with mtime-based caching. Returns empty string if
    missing or unreadable."""
    if not slug:
        return ""
    path = os.path.join(IDENTITY_DIR, f"{slug}.md")
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return ""
    cached = _identity_cache.get(path)
    if cached and cached[0] == st.st_mtime:
        return cached[1]
    try:
        with open(path, "r", encoding="utf-8") as fh:
            content = fh.read(IDENTITY_MAX_BYTES)
    except OSError:
        return ""
    _identity_cache[path] = (st.st_mtime, content)
    return content


def _extract_json(text: str) -> str | None:
    """`openclaw agent --json` prints the JSON document on stdout. The runtime
    may interleave node UNDICI proxy warnings on stdout in some configs, so
    skip lines until we find one that begins with '{'."""
    for i, line in enumerate(text.splitlines(keepends=True)):
        if line.startswith("{"):
            offset = sum(len(s) for s in text.splitlines(keepends=True)[:i])
            return text[offset:]
    return None


def run_openclaw(session_id: str, message: str, op: dict | None = None) -> str:
    # Pass operator identity down to anything `openclaw agent` shells out to
    # (chad-webui in particular). Defense in depth — the message prefix tells
    # the model *who* it's talking to; CHAD_OPERATOR_SLUG lets downstream
    # tooling pick a per-operator API key so OpenWebUI's permission system
    # enforces scope independent of the LLM's discipline.
    env = os.environ.copy()
    if op:
        env["CHAD_OPERATOR_EMAIL"] = op.get("email", "")
        env["CHAD_OPERATOR_SLUG"] = op.get("slug", "")
        env["CHAD_OPERATOR_ROLE"] = op.get("role", "")
        env["CHAD_OPERATOR_CHAT_ID"] = op.get("chat_id", "")
    proc = subprocess.run(
        [
            OPENCLAW_BIN, "agent", "--json",
            "--agent", AGENT_ID,
            "--session-id", session_id,
            "--message", message,
            "--timeout", str(TIMEOUT_SEC),
        ],
        capture_output=True, text=True, timeout=TIMEOUT_SEC + 30,
        env=env,
    )
    # OpenClaw 2026.4.24+ emits --json on stdout (was stderr in 2026.4.9).
    # Try stdout first, fall back to stderr for older runtimes.
    raw = _extract_json(proc.stdout or "") or _extract_json(proc.stderr or "")
    if raw is None:
        return f"[chad-shim] openclaw produced no JSON (rc={proc.returncode})\n{(proc.stderr or '')[-1500:]}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        return f"[chad-shim] JSON parse failed: {e}\n{raw[:1500]}"
    # 2026.4.24+ wraps the response under "result"; older runtimes had it
    # at the root. Walk both and use whichever has payloads.
    result = data.get("result") if isinstance(data.get("result"), dict) else data
    payloads = result.get("payloads") or []
    parts = [p.get("text", "") for p in payloads if isinstance(p, dict) and p.get("text")]
    if parts:
        return "\n".join(parts)
    stop = (result.get("meta") or {}).get("stopReason")
    return f"[chad-shim] empty reply (stopReason={stop!r}); openclaw returned no text payloads."


def fallback_session_id(body: dict) -> str:
    """Used when no X-OpenWebUI-Chat-Id header is present (e.g. direct API
    callers). Mirrors the prior behavior: stable hash of the first message."""
    messages = body.get("messages") or []
    if not messages:
        return "webui-empty-" + uuid.uuid4().hex[:8]
    seed = json.dumps(
        [(m.get("role"), m.get("content")) for m in messages[:1]],
        sort_keys=True, default=str,
    )
    return "webui-" + hashlib.sha256(seed.encode()).hexdigest()[:16]


def last_user_text(body: dict) -> str:
    for m in reversed(body.get("messages") or []):
        if m.get("role") != "user":
            continue
        content = m.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "\n".join(
                p.get("text", "") for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            )
    return ""


class Handler(BaseHTTPRequestHandler):
    server_version = "chad-shim/0.3"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[chad-shim {time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}\n")

    def handle_one_request(self) -> None:
        """Wrap the request loop so client-side disconnects don't crash the
        server. BaseHTTPRequestHandler's default propagates BrokenPipeError /
        ConnectionResetError out of `wfile.write()` and Python's socketserver
        doesn't catch it — the whole shim process dies on a single bad client
        (e.g. OpenWebUI dropping the connection mid-stream). chad-shim/0.2
        was killed by this at 16:36Z on 2026-05-14, taking the chad model
        offline until the new chad-shim-watchdog launchd job caught it.
        Catching here is the durable fix."""
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError) as e:
            # Client disconnected mid-response — log and continue, don't die.
            self.log_message("client dropped: %s", e.__class__.__name__)
            try:
                self.close_connection = True
            except Exception:
                pass

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_assistant_text(self, body: dict, text: str) -> None:
        """Send `text` as an OpenAI chat-completion reply (stream or not),
        mirroring the main success path. Used for the allowlist refusal so a
        denied user sees a clean assistant message instead of an error."""
        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        now = int(time.time())
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            chunk = {"id": cid, "object": "chat.completion.chunk", "created": now, "model": MODEL_ID,
                     "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            done = {"id": cid, "object": "chat.completion.chunk", "created": now, "model": MODEL_ID,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            self.wfile.write(f"data: {json.dumps(done)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
            return
        self._send_json(200, {
            "id": cid, "object": "chat.completion", "created": now, "model": MODEL_ID,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })

    def _operator_context(self) -> dict:
        """Pull operator identity from forwarded OpenWebUI headers.

        Returns a dict with keys: email, name, user_id, role, chat_id, slug,
        identity (the loaded md file contents or ''). All values are strings."""
        email = (self.headers.get("X-OpenWebUI-User-Email") or "").strip().lower()
        # Open-webui URL-encodes the name header (quote(name, safe=' ')); decode.
        raw_name = self.headers.get("X-OpenWebUI-User-Name") or ""
        name = unquote(raw_name).strip()
        user_id = (self.headers.get("X-OpenWebUI-User-Id") or "").strip()
        role = (self.headers.get("X-OpenWebUI-User-Role") or "").strip().lower()
        chat_id = (self.headers.get("X-OpenWebUI-Chat-Id") or "").strip()
        slug = _slug_from_email(email)
        identity = _load_identity(slug) if slug else ""
        if not identity and slug:
            # Fall through to default persona for known-but-unmapped users.
            identity = _load_identity("default")
        elif not slug:
            identity = ""  # truly anonymous (curl, no headers) — no prefix
        return {
            "email": email, "name": name, "user_id": user_id, "role": role,
            "chat_id": chat_id, "slug": slug, "identity": identity,
        }

    def _format_operator_prefix(self, op: dict) -> str:
        if not op["identity"]:
            return ""
        header_line = f"[operator: {op['name'] or op['slug']} <{op['email']}> role={op['role'] or 'user'}]"
        return f"{header_line}\n{op['identity'].rstrip()}\n---\n\n"

    def _log_request(self, op: dict, body: dict) -> None:
        if not DEBUG_HEADERS:
            return
        ts = time.strftime("%H:%M:%S")
        sys.stderr.write(
            f"[chad-shim hdr {ts}] op_slug={op['slug']!r} chat_id={op['chat_id']!r} "
            f"identity_len={len(op['identity'])} body_keys={sorted(body.keys())}\n"
        )
        sys.stderr.flush()

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/v1/models", "/models"):
            self._send_json(200, {
                "object": "list",
                "data": [{
                    "id": MODEL_ID,
                    "object": "model",
                    "created": int(time.time()),
                    "owned_by": "chad",
                }],
            })
            return
        if self.path == "/healthz":
            self._send_json(200, {"status": "ok", "agent": AGENT_ID})
            return
        self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/v1/chat/completions", "/chat/completions"):
            self._send_json(404, {"error": {"message": "not found"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": {"message": "invalid json"}})
            return

        op = self._operator_context()
        self._log_request(op, body)

        # Structured request-tracker — every POST gets one JSONL line on
        # completion regardless of success/failure. This is what we use to
        # debug "why are automation chats empty?" without having to grep
        # multiple log streams. Persists to /tmp/chad-shim-requests.jsonl;
        # rotates at ~10MB.
        req_start = time.time()
        req_id = uuid.uuid4().hex[:12]
        request_model = body.get("model") or "?"
        request_chars = sum(len(m.get("content") or "") for m in (body.get("messages") or []) if isinstance(m, dict))
        request_stream = bool(body.get("stream"))

        def _emit_trace(*, status, reply_chars, error=None, openclaw_ms=None):
            """One JSONL line per POST. Captures everything we'd want to know
            when investigating an empty-reply / connection-error incident."""
            try:
                entry = {
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "req_id": req_id,
                    "operator": op.get("slug") or "anon",
                    "operator_role": op.get("role") or "",
                    "chat_id": op.get("chat_id") or "",
                    "model_requested": request_model,
                    "request_chars": request_chars,
                    "stream": request_stream,
                    "duration_ms": int((time.time() - req_start) * 1000),
                    "openclaw_ms": openclaw_ms,
                    "status": status,                      # ok | timeout | empty_reply | error | binary_missing
                    "reply_chars": reply_chars,
                    "error": (error or "")[:200],
                }
                trace_path = "/tmp/chad-shim-requests.jsonl"
                # Naive rotation: when file exceeds 10MB, move to .1 and start fresh.
                try:
                    if os.path.getsize(trace_path) > 10 * 1024 * 1024:
                        os.replace(trace_path, trace_path + ".1")
                except OSError:
                    pass
                with open(trace_path, "a") as fh:
                    fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
            except Exception as e:
                sys.stderr.write(f"[chad-shim] trace emit failed: {e}\n")

        message = last_user_text(body)
        if not message:
            _emit_trace(status="error", reply_chars=0, error="no user message")
            self._send_json(400, {"error": {"message": "no user message in body"}})
            return

        # Operator allowlist gate. When an allowlist is set the premium agent is
        # FAIL-CLOSED: the caller must present an operator email that is on the
        # list. Anonymous / header-less callers are denied too — the old
        # `and op["email"]` short-circuit let a request with no email slip past
        # the gate and reach the agent (an un-authenticated path to premium).
        # Unset allowlist = allow-all (opt-in, backward-compatible). Set
        # CHAD_SHIM_ALLOW_ANON=1 only for trusted local/dev direct-API testing.
        if OPERATOR_ALLOWLIST:
            email = op["email"]
            if not email and not ALLOW_ANON:
                _emit_trace(status="denied", reply_chars=len(DENY_MESSAGE), error="anonymous")
                self._send_assistant_text(body, DENY_MESSAGE)
                return
            if email and email not in OPERATOR_ALLOWLIST:
                _emit_trace(status="denied", reply_chars=len(DENY_MESSAGE))
                self._send_assistant_text(body, DENY_MESSAGE)
                return

        prefix = self._format_operator_prefix(op)
        final_message = prefix + message if prefix else message

        # Session id: prefer the OpenWebUI chat-id (stable per conversation,
        # forwarded regardless of the FORWARD_USER_INFO_HEADERS flag). Scope
        # by operator slug so two different operators on the same chat-id
        # (shouldn't happen, but if it did) would still get separate sessions.
        if op["chat_id"]:
            session_id = f"webui-{op['slug'] or 'anon'}-{op['chat_id']}"
        else:
            session_id = fallback_session_id(body)

        oc_start = time.time()
        try:
            reply = run_openclaw(session_id, final_message, op=op)
        except subprocess.TimeoutExpired:
            _emit_trace(status="timeout", reply_chars=0,
                       openclaw_ms=int((time.time() - oc_start) * 1000),
                       error="openclaw subprocess.TimeoutExpired")
            self._send_json(504, {"error": {"message": "openclaw timed out"}})
            return
        except FileNotFoundError:
            _emit_trace(status="binary_missing", reply_chars=0,
                       openclaw_ms=int((time.time() - oc_start) * 1000),
                       error=f"openclaw bin not found: {OPENCLAW_BIN}")
            self._send_json(500, {"error": {"message": f"openclaw binary not found ({OPENCLAW_BIN})"}})
            return
        oc_ms = int((time.time() - oc_start) * 1000)

        # Classify the reply for trace status. reply that looks like
        # "[chad-shim] ..." is one of our internal error strings.
        if reply.startswith("[chad-shim]"):
            trace_status = "empty_reply" if "empty reply" in reply else "error"
        elif not reply.strip():
            trace_status = "empty_reply"
        else:
            trace_status = "ok"
        _emit_trace(status=trace_status, reply_chars=len(reply), openclaw_ms=oc_ms,
                   error=reply[:200] if trace_status != "ok" else None)

        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        now = int(time.time())
        if body.get("stream"):
            # SSE stream:
            # - Connection: close so the client knows EOF after [DONE] and
            #   stops the spinner. keep-alive made open-webui's frontend
            #   wait the full ~60s read timeout per turn.
            # - Flush each event so the chunk lands as soon as it's written
            #   instead of buffering until the connection closes (Python's
            #   BufferedWriter default behavior on BaseHTTPRequestHandler).
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            chunk = {
                "id": cid, "object": "chat.completion.chunk",
                "created": now, "model": MODEL_ID,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": reply}, "finish_reason": None}],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
            done = {
                "id": cid, "object": "chat.completion.chunk",
                "created": now, "model": MODEL_ID,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(f"data: {json.dumps(done)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            # Explicitly mark connection as not-reusable so BaseHTTPRequestHandler
            # tears down the TCP socket immediately after this handler returns.
            self.close_connection = True
            return

        self._send_json(200, {
            "id": cid, "object": "chat.completion",
            "created": now, "model": MODEL_ID,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        })


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(
        f"[chad-shim] listening on 127.0.0.1:{PORT} (agent={AGENT_ID}, "
        f"openclaw={OPENCLAW_BIN}, timeout={TIMEOUT_SEC}s, debug={DEBUG_HEADERS}, "
        f"identity_dir={IDENTITY_DIR})\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
