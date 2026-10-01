#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# browser-vm relay — OpenWebUI-native terminal server + in-browser VM bridge.
#
# The problem this solves: OpenWebUI runs the model server-side, but the
# CheerpX/WebVM sandbox that executes shell commands boots in the USER'S
# BROWSER TAB. Nothing on the server can reach the VM directly, so a thin
# bridge is required.
#
# Three listeners:
#
#   WS  /vm?chat_id=<id>[&token=…]      <- browser (loader.js CheerpX pod)
#   WS  /api/terminals/{session_id}      <- OpenWebUI terminal proxy
#                                          (native "Open Terminal" panel)
#   POST /api/cmd                        <- browser_shell OpenWebUI Tool
#   GET/POST /files/*                    <- OpenWebUI terminal file browser,
#                                          proxied via /api/v1/terminals/{id}/*
#   GET  /healthz  /api/config  /api/status
#
# The relay speaks the native Open-Terminal *upstream* protocol on the
# `/api/terminals/{session_id}` leg (first-message auth
# `{"type":"auth","token":…}`, then raw xterm frames), so the stock OpenWebUI
# v0.11.4 Web Terminal panel becomes the user's viewport with zero custom UI.
# User keystrokes flow OpenWebUI -> relay -> browser VM; VM output flows back.
#
# The /vm leg uses small JSON control frames (register/ping/exec/…); any frame
# that is not JSON control traffic is forwarded verbatim as terminal bytes.
#
# Concurrency model: one primary browser VM per chat_id (first connection wins,
# a second is rejected with 4009). Multiple native terminal sessions may bridge
# to the same VM. Exec requests are one-at-a-time per chat (pending futures).
#
# Security posture (homelab): the /api/cmd endpoint requires a Bearer
# RELAY_API_KEY when set; the native leg requires the same key when set;
# the browser /vm leg requires RELAY_WS_KEY (or RELAY_API_KEY) when set.
# In production put this behind the Cloudflare Access ACL like OpenWebUI
# itself. Never weaken the model: commands received here are executed inside
# the user-mode browser VM, never on the host.

import asyncio
import base64
import datetime
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import (
    FastAPI,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse, PlainTextResponse, Response

log = logging.getLogger("browser_vm_relay")

# ---------------------------------------------------------------------------
# Config (env)
# ---------------------------------------------------------------------------

RELAY_PORT = int(os.getenv("RELAY_PORT", "8787"))
RELAY_API_KEY = os.getenv("RELAY_API_KEY", "").strip()
RELAY_WS_KEY = os.getenv("RELAY_WS_KEY", "").strip() or RELAY_API_KEY
RELAY_LOG_VERBOSE = os.getenv("RELAY_LOG_VERBOSE", "").strip().lower() in ("1", "true", "yes")
BOOT_WAIT_SECONDS = float(os.getenv("RELAY_BOOT_WAIT_SECONDS", "120"))
EXEC_TIMEOUT_GRACE_SECONDS = float(os.getenv("RELAY_EXEC_GRACE_SECONDS", "5"))
MAX_COMMAND_LENGTH = int(os.getenv("RELAY_MAX_COMMAND_LENGTH", "100000"))
MAX_OUTPUT_BYTES = int(os.getenv("RELAY_MAX_OUTPUT_BYTES", "524288"))  # truncated by browser too
KEEPALIVE_SECONDS = 15

# ---------------------------------------------------------------------------
# Docker backend
# ---------------------------------------------------------------------------
# "browser"  — the VM lives in the user's tab (CheerpX). Default, unchanged.
# "docker"   — the VM is a real PTY in a ttyd container on this network. The
#              WebSocket contract OpenWebUI speaks is identical either way; only
#              the far end of the pipe differs, so every route below branches on
#              this instead of duplicating the Open-Terminal surface.
RELAY_BACKEND = os.getenv("RELAY_BACKEND", "browser").strip().lower()
# Shell run inside the PTY. `docker exec` only when a target container is named;
# with no target it is a shell in the relay's own container, which is the useful
# default and needs no extra service.
DOCKER_SHELL = os.getenv("DOCKER_SHELL", "/bin/bash").strip()
DOCKER_TARGET = os.getenv("DOCKER_TARGET", "").strip()
DOCKER_CWD_DEFAULT = os.getenv("DOCKER_CWD", "/root").strip()
DOCKER_CONNECT_TIMEOUT = float(os.getenv("DOCKER_CONNECT_TIMEOUT", "15"))
# Ring buffer of PTY output kept per session. exec() reads back out of it, and a
# client that attaches late still gets recent scrollback.
DOCKER_SCROLLBACK_BYTES = int(os.getenv("DOCKER_SCROLLBACK_BYTES", "262144"))

CHAT_ID_RE = re.compile(r"^[A-Za-z0-9_\-:\.]{1,160}$")

def _redact_access_log(record: logging.LogRecord) -> bool:
    """Strip credentials from uvicorn access-log request lines.

    Browser VM legs carry the shared key in the WS query string. uvicorn's
    AccessFormatter rebuilds the request line from record.args, but the arg
    shape differs per row type (HTTP 5-tuple vs WebSocket 2-tuple), so scan
    every string arg for sensitive query parameters before formatting.
    """
    try:
        args = record.args
        if isinstance(args, tuple) and any(
            isinstance(a, str) and ("token=" in a or "api_key=" in a) for a in args
        ):
            out = list(args)
            for i, a in enumerate(out):
                if isinstance(a, str):
                    redacted = re.sub(
                        r"([?&](?:token|api_key|key)=)[^&\"]*",
                        r"\g<1><redacted>",
                        a,
                        flags=re.IGNORECASE,
                    )
                    if redacted != a:
                        out[i] = redacted
            record.args = tuple(out)
    except Exception:
        pass
    return True


def _attach_access_redaction() -> None:
    """Attach the query-string redaction filter to uvicorn's access loggers.

    uvicorn 0.53 routes HTTP access rows via ``uvicorn.access`` but WebSocket
    "accepted"/"rejected" rows via ``uvicorn.error`` (both propagate=False), so
    the filter must sit on both.
    """
    for name in ("uvicorn.access", "uvicorn.error"):
        try:
            logging.getLogger(name).addFilter(_redact_access_log)
        except Exception:
            pass


def log_info(short: str, **fields) -> None:
    if not fields:
        log.info(short)
        return
    parts = " ".join(f"{k}={v}" for k, v in fields.items())
    log.info("%s %s", short, parts)


def log_verbose(short: str, **fields) -> None:
    if RELAY_LOG_VERBOSE:
        log_info(short, **fields)


def _safe_chat_id(chat_id) -> str | None:
    if not isinstance(chat_id, str):
        return None
    chat_id = chat_id.strip()
    if not CHAT_ID_RE.match(chat_id):
        return None
    return chat_id


def _safe_terminal_data(data) -> bool:
    """Return True if a frame looks like JSON control traffic."""
    if isinstance(data, bytes):
        probe = data[:1]
        return probe == b"{"
    s = data
    return s.startswith("{") and s.endswith("}")


# ---------------------------------------------------------------------------
# Registry: one VMSession per chat_id
# ---------------------------------------------------------------------------




class VMSession:
    __slots__ = ("_lock", "chat_id", "client", "native_sessions", "pending", "since", "ws")

    def __init__(self, chat_id: str):
        self.chat_id = chat_id
        self.ws = None  # browser WebSocket (primary, single)
        self.client = ""
        self.since = time.time()
        self.pending = {}  # exec_id -> asyncio.Future
        self.native_sessions = set()  # active native terminal WS objects
        self._lock = asyncio.Lock()


class RelayState:
    def __init__(self):
        self.sessions = {}  # chat_id -> VMSession
        self.cwd = {}  # chat_id -> absolute cwd for the Open Terminal file browser
        self.executes = {}  # chat_id -> list of executed-command records (TerminalDock)
        self.term_sessions = {}  # session_id -> open-terminal session record
        self.docker = {}  # chat_id -> DockerSession (RELAY_BACKEND=docker only)
        self.lock = asyncio.Lock()

    async def get(self, chat_id: str) -> VMSession | None:
        async with self.lock:
            return self.sessions.get(chat_id)

    async def get_docker(self, chat_id: str) -> "DockerSession | None":
        async with self.lock:
            return self.docker.get(chat_id)

    async def get_or_create_docker(self, chat_id: str) -> "DockerSession":
        """Return this chat's container PTY, connecting on first use.

        One PTY per chat, shared by every client on it — same shape as the
        browser leg, so the user's keystrokes and the agent's exec land in one
        shell with one scrollback.
        """
        async with self.lock:
            sess = self.docker.get(chat_id)
        if sess is not None and sess.ready:
            return sess
        fresh = DockerSession(chat_id)
        await fresh.connect()
        async with self.lock:
            prev = self.docker.get(chat_id)
            if prev is not None and prev.ready:
                # Lost a race; keep the winner and drop ours.
                asyncio.create_task(fresh.close())
                return prev
            self.docker[chat_id] = fresh
            self.cwd.setdefault(chat_id, "/root")
        log_info("docker pty ready", chat_id=chat_id)
        return fresh

    async def drop_docker(self, chat_id: str) -> None:
        async with self.lock:
            sess = self.docker.pop(chat_id, None)
        if sess is not None:
            await sess.close()

    async def register(self, sess: VMSession) -> bool:
        """Register a browser VM. Returns False if a VM is already primary for the chat."""
        async with self.lock:
            prev = self.sessions.get(sess.chat_id)
            if prev is not None and prev.ws is not None:
                log_info("vm register rejected", chat_id=sess.chat_id, reason="already_primary")
                return False
            self.sessions[sess.chat_id] = sess
            self.cwd[sess.chat_id] = "/root"  # fresh VM, fresh file-browser cwd
            return True

    async def unregister(self, sess: VMSession) -> None:
        async with self.lock:
            if self.sessions.get(sess.chat_id) is sess:
                del self.sessions[sess.chat_id]
            self.cwd.pop(sess.chat_id, None)
            # Drop open-terminal session records that pointed at this VM.
            for sid in [k for k, v in self.term_sessions.items() if v["chat_id"] == sess.chat_id]:
                del self.term_sessions[sid]
        self.executes.pop(sess.chat_id, None)
        # Fail any pending execs for detached VMs.
        for fut in sess.pending.values():
            if not fut.done():
                fut.set_exception(RelayInternalError("browser_disconnected"))
        sess.pending.clear()

    def add_native(self, chat_id: str, ws) -> None:
        sess = self.sessions.get(chat_id)
        if sess is not None:
            sess.native_sessions.add(ws)

    def drop_native(self, chat_id: str, ws) -> None:
        sess = self.sessions.get(chat_id)
        if sess is not None:
            sess.native_sessions.discard(ws)


state = RelayState()


class RelayInternalError(Exception):
    pass


class NoBrowserError(RelayInternalError):
    pass


class ExecTimedOut(RelayInternalError):
    pass


# ---------------------------------------------------------------------------
# Docker session: a real PTY in a ttyd container
# ---------------------------------------------------------------------------
# ttyd speaks a tiny framed protocol over its WebSocket, documented by
# convention rather than by a spec:
#
#   client -> server   b"0" + payload        input
#                      b"1" + cols + rows    resize (one byte each, 1..255)
#   server -> client   b"0" + payload        output
#                      b"1" + payload        window title
#                      b"2" + payload        preferences (ignored)
#
# Everything below the framing layer is a byte pump, which is what makes this
# interchangeable with the CheerpX leg: OpenWebUI sees the same Open-Terminal
# contract either way, so nothing above this class needed to change.


@asynccontextmanager
async def lifespan(app: FastAPI):
    # uvicorn's dictConfig resets logger filters during server setup; re-attach
    # after configuration so access-log lines never leak WS query-string keys.
    _attach_access_redaction()
    loop = asyncio.get_running_loop()
    keepalive = asyncio.create_task(_keepalive_loop(loop))
    app.state.bv_keepalive = keepalive
    yield
    keepalive.cancel()


app = FastAPI(title="browser-vm relay", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Trailing-slash normalisation
# ---------------------------------------------------------------------------
# OpenWebUI's terminal client requests these endpoints *with* a trailing slash
# (``POST /api/terminals/``) while they are registered without one. FastAPI's
# built-in redirect_slashes answers with a 307, and OpenWebUI's aiohttp proxy
# does not replay the Authorization header across that redirect, so every
# create/list came back 401 even though the key was correct. Rewrite the path
# in-process instead of redirecting.
#
# Implemented as raw ASGI (not BaseHTTPMiddleware) so it costs nothing per byte
# on the streaming file endpoints and so it provably runs before routing.
class _SlashNormaliser:
    def __init__(self, app, get_routes):
        self.app = app
        self._get_routes = get_routes
        self._patterns: list | None = None

    def _slashless(self) -> list:
        if self._patterns is None:
            from starlette.routing import Route, compile_path

            # Computed once, on first request: every @app.get/@app.post below has
            # been registered by then. Route *patterns* (not literal paths) so
            # that parameterised routes such as /api/terminals/{session_id}
            # match the concrete id the client actually requested.
            self._patterns = [
                compile_path(r.path)[0]
                for r in self._get_routes()
                if isinstance(r, Route) and not r.path.endswith("/")
            ]
        return self._patterns

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            path = scope.get("path", "")
            if len(path) > 1 and path.endswith("/"):
                stripped = path[:-1]
                if any(p.match(stripped) for p in self._slashless()):
                    scope["path"] = stripped
                    raw = scope.get("raw_path")
                    if raw and raw.endswith(b"/"):
                        scope["raw_path"] = raw[:-1]
        await self.app(scope, receive, send)


app.add_middleware(_SlashNormaliser, get_routes=lambda: app.routes)


# ---------------------------------------------------------------------------
# Browser leg: WS /vm
# ---------------------------------------------------------------------------

CONTROL_TYPES = {"register", "pong", "exec_result", "reset_ack", "status"}




class DockerSession:
    """A real PTY, shared by every client on this chat.

    The PTY comes from `os.openpty()` and a shell is exec'd onto the slave end,
    so this is a genuine terminal (job control, echo, window size) rather than
    a pipe pair pretending to be one. An earlier attempt drove this through
    ttyd's WebSocket framing instead; that worked but added a third-party
    handshake to debug and a second container to keep alive, and the relay can
    own the PTY directly with nothing but the standard library.

    The shell is whatever DOCKER_SHELL says, wrapped in `docker exec` when
    DOCKER_TARGET is set so the terminal lands inside that container. With no
    target it is a shell in the relay's own container, which is the useful
    default for a "scratch terminal" and needs no extra plumbing.
    """

    __slots__ = (
        "chat_id", "pending", "since", "native_sessions",
        "_master", "_proc", "_loop", "_reader", "_buf", "_lock", "_cols", "_rows",
    )

    def __init__(self, chat_id: str):
        self.chat_id = chat_id
        self.pending: dict[str, asyncio.Future] = {}
        self.since = time.time()
        self.native_sessions: set = set()
        self._master: int | None = None
        self._proc = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._reader = None
        self._buf = ""
        self._lock = asyncio.Lock()
        self._cols, self._rows = 80, 24

    @property
    def ready(self) -> bool:
        return self._master is not None and self._proc is not None

    def _argv(self) -> list[str]:
        shell = DOCKER_SHELL
        argv = [shell, "-l"] if os.path.basename(shell) == "bash" else [shell]
        if DOCKER_TARGET:
            # -i keeps stdin a tty; -t forces a pty inside the container. Without
            # both, `docker exec` hands the shell a pipe and the guest tty goes
            # missing, which breaks stty/echo and the exec markers.
            argv = ["docker", "exec", "-i", "-t", "-w", DOCKER_CWD_DEFAULT, DOCKER_TARGET] + argv
        return argv

    async def connect(self) -> None:
        import fcntl
        import struct
        import termios

        self._loop = asyncio.get_running_loop()
        self._master, slave = os.openpty()
        try:
            self._set_size(self._master, self._cols, self._rows)
            self._proc = subprocess.Popen(
                self._argv(),
                stdin=slave, stdout=slave, stderr=slave,
                start_new_session=True,   # own process group: ^C reaches the shell
                close_fds=True,
                env={**os.environ, "TERM": "xterm-256color", "HOME": DOCKER_CWD_DEFAULT},
            )
        finally:
            os.close(slave)

        def _on_readable():
            try:
                data = os.read(self._master, 65536)
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                data = b""
            if not data:
                # EOF: the shell exited. Stop watching the fd so the loop
                # doesn't spin on a permanently-readable closed pty.
                try:
                    self._loop.remove_reader(self._master)
                except Exception:
                    pass
                return
            self._loop.create_task(self._ingest(data))

        self._reader = self._loop.add_reader(self._master, _on_readable)

    @staticmethod
    def _set_size(fd: int, cols: int, rows: int) -> None:
        import fcntl
        import struct
        import termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    async def _ingest(self, data: bytes) -> None:
        async with self._lock:
            self._buf += data.decode("utf-8", "replace")
            if len(self._buf) > DOCKER_SCROLLBACK_BYTES:
                # exec() only ever needs the tail, and a bound buffer keeps a
                # long-lived session from growing without limit.
                self._buf = self._buf[-DOCKER_SCROLLBACK_BYTES:]
        for ws in list(self.native_sessions):
            try:
                await ws.send_bytes(data)
            except Exception:
                self.native_sessions.discard(ws)

    async def write(self, data: bytes) -> None:
        if self._master is None:
            raise RelayInternalError("docker pty not connected")
        os.write(self._master, data)

    async def resize(self, cols: int, rows: int) -> None:
        self._cols = max(1, min(int(cols), 500))
        self._rows = max(1, min(int(rows), 500))
        if self._master is None:
            return
        try:
            self._set_size(self._master, self._cols, self._rows)
        except OSError:
            pass

    async def snapshot_tail(self, limit: int = DOCKER_SCROLLBACK_BYTES) -> str:
        async with self._lock:
            return self._buf[-limit:]

    async def run(self, command: str, timeout_ms: int, cwd: str | None = None) -> dict:
        """Run *command* in the PTY and recover its output from the stream.

        A tty has one stream, so stdout and stderr interleave and cannot be
        separated; that is reported honestly rather than faked.

        Two details are load-bearing, both learned the hard way:

        * The sentinel is emitted as an OSC 999 sequence whose token is split
          across two printf arguments. With the token in one argument, the
          terminal's own echo of the typed line contains the marker verbatim and
          the capture matches its own echo instead of the command's output,
          returning fragments of the wrapper rather than any results.
        * The command runs inside a subshell. In `{ ... }` a command like
          `exit 7` tears down the whole session — the pty dies and every later
          write fails with EIO — instead of just failing that one exec.
        """
        token = uuid.uuid4().hex[:8]
        half, rest = token[:4], token[4:]
        begin = "\x1b]999;bv" + half + rest + "-b\x07"
        end_seq = "\x1b]999;bv" + half + rest + "-e"

        # One physical line, so bash never enters continuation mode. An earlier
        # version spread this over several lines; the embedded newlines after
        # `(` put the shell into PS2, which printed `> ` prompts straight into
        # the captured output and swallowed the command.
        script = (
            "stty -echo 2>/dev/null; "
            + "printf '\\033]999;bv%s%s-b\\007' " + _q(half) + " " + _q(rest) + "; "
            + "( "
            + (f"cd {_q(cwd)} 2>/dev/null; " if cwd else "")
            + command
            + " ); __rc=$?; "
            + "printf '\\033]999;bv%s%s-e%s\\007' "
            + _q(half) + " " + _q(rest) + " \"$__rc\"; "
            + "stty echo 2>/dev/null\n"
        )

        deadline = time.time() + (timeout_ms / 1000.0) + EXEC_TIMEOUT_GRACE_SECONDS
        await self.write(script.encode())

        # Poll the shared buffer for the closing sentinel. Non-destructive: the
        # read pump keeps appending to the same buffer throughout.
        while time.time() < deadline:
            async with self._lock:
                buf = self._buf
            head = buf.find(begin)
            if head >= 0:
                rest_buf = buf[head + len(begin):]
                stop = rest_buf.find(end_seq)
                if stop >= 0:
                    body = rest_buf[:stop]
                    tail = rest_buf[stop + len(end_seq):]
                    digits = ""
                    for ch in tail:
                        if ch.isdigit():
                            digits += ch
                        elif digits:
                            break
                        elif ch not in ("-", "\x1b", "]999;bv", "\x07"):
                            break
                    return {
                        "id": token,
                        "exit": int(digits) if digits.isdigit() else 0,
                        "stdout": body.replace("\r\n", "\n").replace("\r", "\n"),
                        "stderr": "",
                    }
            await asyncio.sleep(0.05)

        raise ExecTimedOut("command did not finish inside the container PTY")

    def _fail_pending(self, reason: str) -> None:
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(RelayInternalError(reason))
        self.pending.clear()

    async def close(self) -> None:
        if self._loop is not None and self._master is not None and self._reader is not None:
            try:
                self._loop.remove_reader(self._master)
            except Exception:
                pass
        self._reader = None
        if self._proc is not None:
            try:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=3)
                except Exception:
                    self._proc.kill()
            except Exception:
                pass
            self._proc = None
        if self._master is not None:
            try:
                os.close(self._master)
            except OSError:
                pass
            self._master = None
        self._fail_pending("docker session closed")




# ---------------------------------------------------------------------------
# Native (Open-Terminal) leg: WS /api/terminals/{session_id}
# ---------------------------------------------------------------------------


async def _docker_native_handler(ws: WebSocket, session_id: str, chat_id: str):
    """Bridge an Open Terminal WebSocket to the container PTY for this chat.

    The auth frame has already been consumed by the caller, so from here the
    socket is a raw byte pipe in both directions — the same contract the browser
    leg satisfies, which is why nothing above this point had to change.
    """
    try:
        sess = await state.get_or_create_docker(chat_id)
    except Exception:
        log.exception("docker pty connect failed chat_id=%s", chat_id)
        await ws.send_text("\r\n[browser-vm] Could not start the container shell.\r\n")
        await ws.close(code=4001, reason="docker pty unavailable")
        return

    sess.native_sessions.add(ws)
    log.info("docker terminal bridged chat_id=%s session=%s", chat_id, session_id)

    # A late joiner still wants context, so replay the tail of the PTY.
    tail = await sess.snapshot_tail(8192)
    if tail:
        try:
            await ws.send_bytes(tail.encode("utf-8", "replace"))
        except Exception:
            pass

    # Match the client's geometry so the container's tty reports sane rows/cols.
    # There is no resize until the client sends one, so seed it with a default.
    await sess.resize(80, 24)

    running = True

    async def _client_to_pty():
        while running:
            event = await ws.receive()
            if event["type"] == "websocket.disconnect":
                break
            data = event.get("bytes")
            if data:
                await sess.write(data)
                continue
            text = event.get("text")
            if not text:
                continue
            # OpenWebUI sends {"type":"resize",...} as a text frame; everything
            # else is typed input. Same split as the browser leg.
            if text.startswith("{"):
                try:
                    msg = json.loads(text)
                except ValueError:
                    await sess.write(text.encode())
                    continue
                if msg.get("type") == "resize":
                    await sess.resize(msg.get("cols", 80), msg.get("rows", 24))
                    continue
            await sess.write(text.encode())

    try:
        await _client_to_pty()
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("docker terminal pump failed chat_id=%s", chat_id)
    finally:
        running = False
        sess.native_sessions.discard(ws)
        try:
            await ws.close()
        except Exception:
            pass
        log.info("docker terminal closed chat_id=%s session=%s", chat_id, session_id)


async def _native_handler(
    ws: WebSocket,
    session_id: str,
    x_session_id: str | None,
    x_terminal_context: str | None,
):
    await ws.accept()

    # First-message auth: OpenWebUI sends the connection key (or JWT).
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=15.0)
        payload = json.loads(raw)
        token = payload.get("token", "")
        if payload.get("type") != "auth" or not isinstance(token, str):
            await ws.close(code=4001, reason="expected auth frame")
            return
    except (TimeoutError, ValueError):
        await ws.close(code=4001, reason="auth timeout or invalid payload")
        return

    if RELAY_API_KEY and token != RELAY_API_KEY:
        await ws.close(code=4001, reason="bad token")
        return

    # Resolve which browser VM this native session maps to.
    chat_id = _safe_chat_id(x_session_id) or _chat_id_from_context(x_terminal_context)
    if chat_id is None:
        await ws.close(code=4003, reason="terminal requires a chat context")
        return

    # Wait (bounded) for the browser VM to boot & register. In docker mode there
    # is no browser to wait for: the PTY is opened on demand, so connecting is
    # what brings the container up.
    if RELAY_BACKEND == "docker":
        await _docker_native_handler(ws, session_id, chat_id)
        return

    sess = await _wait_for_vm(chat_id)
    if sess is None:
        await ws.send_text(
            "\r\n[browser-vm] No browser connected for this chat. "
            "Open this chat in a browser tab with the Local VM enabled.\r\n"
        )
        await ws.close(code=4001, reason="no browser vm for chat")
        return

    log.info("native terminal bridged chat_id=%s session=%s", chat_id, session_id)

    sess.native_sessions.add(ws)
    running = True

    # Encourage the browser to boot its pod the moment a native terminal
    # attaches, so the dock shows live boot output instead of a blank tab.
    await _browser_send(sess, json.dumps({"type": "term:require"}))

    async def _native_to_vm():
        nonlocal running
        while running:
            try:
                msg = await ws.receive()
            except Exception:
                break
            if msg.get("type") == "websocket.disconnect":
                break
            data = None
            if msg.get("text") is not None:
                data = msg["text"]
            elif msg.get("bytes") is not None:
                data = msg["bytes"]
            if data is None:
                continue
            if isinstance(data, bytes):
                # Keystrokes arrive as raw binary; envelope them so the browser
                # treats them as terminal INPUT (not console output to echo back).
                payload = json.dumps(
                    {"type": "term:data", "data": base64.b64encode(data).decode("ascii"), "enc": "b64"}
                )
            else:
                text = data
                ctl = None
                if text.startswith("{"):
                    try:
                        ctl = json.loads(text)
                    except (ValueError, TypeError):
                        ctl = None
                if isinstance(ctl, dict) and ctl.get("type") == "resize":
                    rows = ctl.get("rows", 24)
                    cols = ctl.get("cols", 80)
                    try:
                        rows = max(1, min(int(rows), 300))
                        cols = max(1, min(int(cols), 300))
                    except (TypeError, ValueError):
                        rows, cols = 24, 80
                    payload = json.dumps({"type": "term:resize", "rows": rows, "cols": cols})
                else:
                    # Non-resize text from the client: treat as typed input.
                    payload = json.dumps({"type": "term:data", "data": text})
            await _browser_send(sess, payload)

    async def _vm_to_native_loop():
        # VM -> native happens via _vm_to_native() fan-out; nothing to poll here.
        await asyncio.Event().wait()  # cancelled on teardown

    tasks = [asyncio.create_task(_native_to_vm()), asyncio.create_task(_vm_to_native_loop())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        running = False
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        state.drop_native(chat_id, ws)
        try:
            await ws.close()
        except Exception:
            pass
        log.info("native terminal closed chat_id=%s session=%s", chat_id, session_id)


def _chat_id_from_context(ctx: str | None) -> str | None:
    if isinstance(ctx, str) and ctx.startswith("chat:"):
        return _safe_chat_id(ctx[len("chat:") :])
    return None


async def _wait_for_vm(chat_id: str) -> VMSession | None:
    deadline = time.time() + BOOT_WAIT_SECONDS
    while time.time() < deadline:
        sess = await state.get(chat_id)
        if sess is not None and sess.ws is not None:
            return sess
        await asyncio.sleep(0.5)
    return None


async def _browser_send(sess: VMSession, data) -> None:
    if sess.ws is None:
        return
    try:
        if isinstance(data, bytes):
            await sess.ws.send_bytes(data)
        else:
            await sess.ws.send_text(data)
    except Exception:
        pass


def _handle_vm_control(sess: VMSession, msg: dict) -> None:
    """Resolve a control frame the browser VM sent back over the /vm socket."""
    t = msg.get("type")
    if t == "register":
        sess.client = str(msg.get("client", ""))[:64]
    elif t == "exec_result":
        fut = sess.pending.get(msg.get("id"))
        if fut is not None and not fut.done():
            fut.set_result(
                {
                    "exit": msg.get("exit", msg.get("exit_code", -1)),
                    "stdout": msg.get("stdout", ""),
                    "stderr": msg.get("stderr", ""),
                }
            )
    elif t == "reset_ack":
        fut = sess.pending.get(msg.get("id"))
        if fut is not None and not fut.done():
            fut.set_result({"ok": True})
    # "pong" / "status": keepalive / informational — nothing to resolve.


async def _mirror_to_native(sess: VMSession, data) -> None:
    """Fan VM console output out to any bridged native Open-Terminal sessions."""
    for nws in list(sess.native_sessions):
        try:
            if isinstance(data, bytes):
                await nws.send_bytes(data)
            else:
                await nws.send_text(data)
        except Exception:
            sess.native_sessions.discard(nws)


async def _vm_handler(ws: WebSocket, chat_id: str) -> None:
    """Bridge one browser VM (the in-tab CheerpX pod) for a chat.

    Browser -> relay: JSON control frames (register / pong / exec_result /
    reset_ack / status), plus raw text/binary = VM console output which is
    mirrored to any bridged native Open-Terminal sessions. Relay -> browser:
    exec / ping / reset (sent from _vm_exec, the keepalive loop, and resetVm).

    This is what makes the agent's exec reach the pod: _vm_exec() parks a future
    in sess.pending[exec_id] and sends {type:exec,…}; the browser runs it and
    replies {type:exec_result,id,…}, which we resolve here. It was missing
    entirely (ws_vm referenced an undefined name), and the /vm-bridge auth
    reject masked the NameError — so the browser leg never registered and every
    agent exec returned no_browser.
    """
    await ws.accept()
    sess = VMSession(chat_id)
    sess.ws = ws
    if not await state.register(sess):
        # Another tab already owns this chat's VM; the newcomer steps aside
        # rather than hijacking the primary (the browser will not retry a 4009).
        await ws.close(code=4009, reason="vm already registered for chat")
        return
    log_info("vm registered", chat_id=chat_id, client=sess.client)
    try:
        while True:
            event = await ws.receive()
            if event.get("type") == "websocket.disconnect":
                break
            text = event.get("text")
            if text is not None:
                msg = None
                if text[:1] == "{":
                    try:
                        msg = json.loads(text)
                    except ValueError:
                        msg = None
                if isinstance(msg, dict) and msg.get("type") in CONTROL_TYPES:
                    _handle_vm_control(sess, msg)
                else:
                    await _mirror_to_native(sess, text)
                continue
            data = event.get("bytes")
            if data is not None:
                await _mirror_to_native(sess, data)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("vm handler error chat_id=%s", chat_id)
    finally:
        await state.unregister(sess)
        log_info("vm unregistered", chat_id=chat_id)


# ---------------------------------------------------------------------------
# Heads-up: terminal data from the browser is forwarded to all bridged
# native sessions by _vm_to_native. Native->browser is handled by
# _native_to_vm above.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Tool HTTP API
# ---------------------------------------------------------------------------


def _require_bearer(request: Request) -> None:
    if not RELAY_API_KEY:
        return
    header = request.headers.get("authorization", "")
    if header != f"Bearer {RELAY_API_KEY}":
        raise HTTPException(status_code=401, detail="unauthorized")


# ---------------------------------------------------------------------------
# Shared exec plumbing (tool + Open Terminal file API)
# ---------------------------------------------------------------------------

FILE_READ_CAP = 350_000  # below the browser's exec stdout clip (524288 B)
UPLOAD_MAX_BODY = 2_000_000  # max multipart POST body accepted for /files/upload


async def _vm_exec(chat_id: str, command: str, timeout_ms: int = 30000, cwd: str | None = None) -> dict:
    """Run *command* inside the registered browser VM; return the exec result.

    Raises NoBrowserError when no VM is connected and RelayInternalError on
    timeout. At most MAX_COMMAND_LENGTH chars per command.
    """
    if not isinstance(command, str) or not command.strip() or len(command) > MAX_COMMAND_LENGTH:
        raise RelayInternalError("invalid_command")

    # In docker mode the "VM" is the container PTY, so every caller of this
    # function — the tool leg, /files/*, /execute, /ports — transparently runs
    # in the container instead of the browser. One branch here beats duplicating
    # each of those routes.
    if RELAY_BACKEND == "docker":
        sess = await state.get_or_create_docker(chat_id)
        return await sess.run(command, timeout_ms, cwd)

    sess = await state.get(chat_id)
    if sess is None or sess.ws is None:
        raise NoBrowserError()

    exec_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    fut.bv_started = time.time()  # type: ignore[attr-defined]
    sess.pending[exec_id] = fut

    await _browser_send(
        sess,
        json.dumps(
            {
                "type": "exec",
                "id": exec_id,
                "cmd": command,
                "cwd": cwd if cwd is not None else state.cwd.get(chat_id, "/root"),
                "timeout_ms": timeout_ms,
            }
        ),
    )

    deadline = timeout_ms / 1000.0 + EXEC_TIMEOUT_GRACE_SECONDS
    try:
        result = await asyncio.wait_for(fut, timeout=deadline)
    except TimeoutError:
        sess.pending.pop(exec_id, None)
        raise RelayInternalError("exec_timeout") from None
    finally:
        sess.pending.pop(exec_id, None)
    return result


async def _file_exec(chat_id: str, command: str, timeout_ms: int = 60000) -> dict:
    try:
        return await _vm_exec(chat_id, command, timeout_ms=timeout_ms)
    except NoBrowserError:
        raise HTTPException(
            status_code=409,
            detail="The terminal VM is not open in a browser for this chat",
        ) from None
    except RelayInternalError:
        raise HTTPException(
            status_code=504,
            detail="The terminal VM did not respond in time",
        ) from None


def _q(path: str) -> str:
    """Single-quote a path for insertion into an sh command line."""
    return "'" + path.replace("'", "'\\''") + "'"


def _file_chat_id(request: Request) -> str | None:
    cid = request.headers.get("x-session-id")
    if cid is None:
        cid = request.query_params.get("chat_id") or ""
    return _safe_chat_id(cid)


def _file_scope(request: Request) -> str:
    chat_id = _file_chat_id(request)
    if chat_id is None:
        raise HTTPException(status_code=400, detail="chat context required")
    return chat_id


def _resolve(cwd: str, p: str) -> str:
    if not isinstance(p, str) or not p:
        return cwd
    if not p.startswith("/"):
        p = os.path.join(cwd, p)
    return os.path.normpath(p)


# ---------------------------------------------------------------------------
# Open Terminal file API. Mirrors the open-terminal REST contract that the
# stock OpenWebUI Web Terminal sidebar file browser calls (proxied through
# /api/v1/terminals/{server_id}/{path}). Every operation executes inside the
# user's CheerpX VM — the relay never touches the files itself.
# ---------------------------------------------------------------------------


FILE_DIR_ENTRY_SH = (
    "d=__D__; if [ ! -d \"$d\" ]; then echo CXFERR_NOTDIR; exit 2; fi; "
    "for f in \"$d\"/* \"$d\"/.[!.]* \"$d\"/..?*; do [ -e \"$f\" ] || continue; "
    "n=\"${f##*/}\"; "
    "if [ -d \"$f\" ]; then t=directory; else t=file; fi; "
    "s=$(wc -c < \"$f\" 2>/dev/null | tr -d ' ' || printf 0); "
    "if LC_ALL=C stat -c %Y \"$f\" >/dev/null 2>&1; then m=$(LC_ALL=C stat -c %Y \"$f\"); else m=0; fi; "
    "w=no; [ -w \"$f\" ] && w=yes; "
    "printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$n\" \"$t\" \"$s\" \"$m\" \"$w\"; done"
)

READ_SH = (
    "f=__F__; if [ ! -e \"$f\" ]; then echo CXFERR_NOTFOUND; exit 2; fi; "
    "if [ -d \"$f\" ]; then echo CXFERR_ISDIR; exit 3; fi; "
    "s=$(LC_ALL=C stat -c %s \"$f\" 2>/dev/null || echo 0); "
    "if [ \"$s\" -gt __CAP__ ]; then echo CXERR_TOOBIG; exit 4; fi; "
    "echo CXB64START; base64 < \"$f\" | tr -d '\\n'; echo; echo CXB64END"
)

_B64_MARKER = re.compile(r"CXB64START\n(.*?)\nCXB64END", re.DOTALL)


def _parse_entries(stdout: str) -> list[dict]:
    entries = []
    for line in stdout.splitlines():
        if not line or line.startswith("CXERR") or line.startswith("CXFERR"):
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        name, etype = parts[0], parts[1]
        try:
            size = int(parts[2] or 0)
        except ValueError:
            size = 0
        try:
            modified = float(parts[3] or 0)
        except ValueError:
            modified = 0.0
        writable = len(parts) < 5 or parts[4] == "yes"
        entries.append(
            {"name": name, "type": etype, "size": size, "modified": modified, "writable": writable}
        )
    entries.sort(key=lambda e: (e["name"].lower(), e["name"]))
    return entries


async def _read_bytes(chat_id: str, target: str) -> bytes:
    result = await _file_exec(
        chat_id,
        READ_SH.replace("__F__", _q(target)).replace("__CAP__", str(FILE_READ_CAP)),
    )
    out = result.get("stdout", "")
    if "CXFERR_NOTFOUND" in out:
        raise HTTPException(status_code=404, detail="File not found")
    if "CXFERR_ISDIR" in out:
        raise HTTPException(status_code=400, detail="Is a directory")
    if "CXERR_TOOBIG" in out:
        raise HTTPException(
            status_code=416,
            detail=f"File exceeds the {FILE_READ_CAP}-byte relay read cap",
        )
    match = _B64_MARKER.search(out)
    if match is None:
        raise HTTPException(status_code=502, detail="unexpected VM response")
    try:
        return base64.b64decode(match.group(1))
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="unexpected VM response") from None


async def _file_body(request: Request) -> dict:
    try:
        raw = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="invalid json") from None
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="invalid json")
    return raw


@app.get("/files/cwd")
async def files_get_cwd(request: Request):
    _require_bearer(request)
    chat_id = _file_scope(request)
    return {"cwd": state.cwd.get(chat_id, "/root"), "home": "/root"}


@app.post("/files/cwd")
async def files_set_cwd(request: Request):
    _require_bearer(request)
    chat_id = _file_scope(request)
    body = await _file_body(request)
    target = _resolve(state.cwd.get(chat_id, "/root"), str(body.get("path", "")))
    result = await _file_exec(chat_id, f"test -d {_q(target)}")
    if result["exit"] != 0:
        raise HTTPException(status_code=404, detail="Directory not found")
    state.cwd[chat_id] = target
    return {"cwd": target}


@app.get("/files/list")
async def files_list(request: Request, directory: str = "."):
    _require_bearer(request)
    chat_id = _file_scope(request)
    target = _resolve(state.cwd.get(chat_id, "/root"), directory)
    result = await _file_exec(chat_id, FILE_DIR_ENTRY_SH.replace("__D__", _q(target)))
    if result["exit"] != 0 or "CXFERR_NOTDIR" in result.get("stdout", ""):
        raise HTTPException(status_code=404, detail="Directory not found")
    return {"dir": target, "writable": True, "entries": _parse_entries(result.get("stdout", ""))}


@app.get("/files/read")
async def files_read(request: Request, path: str, start_line: int | None = None, end_line: int | None = None):
    _require_bearer(request)
    chat_id = _file_scope(request)
    target = _resolve(state.cwd.get(chat_id, "/root"), path)
    data = await _read_bytes(chat_id, target)

    mime, _ = mimetypes.guess_type(target)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        if mime and mime.startswith("image/"):
            return Response(content=data, media_type=mime)
        raise HTTPException(status_code=415, detail="Unsupported binary file type") from None

    lines = text.splitlines(keepends=True)
    total = len(lines)
    start = (int(start_line) - 1) if start_line else 0
    end = int(end_line) if end_line else total
    content = "".join(lines[max(start, 0) : min(end, total)]) if end > max(start, 0) else ""
    return {"path": target, "total_lines": total, "content": content}


@app.get("/files/view")
async def files_view(request: Request, path: str):
    _require_bearer(request)
    chat_id = _file_scope(request)
    target = _resolve(state.cwd.get(chat_id, "/root"), path)
    data = await _read_bytes(chat_id, target)
    mime, _ = mimetypes.guess_type(target)
    return Response(content=data, media_type=mime or "application/octet-stream")


@app.post("/files/mkdir")
async def files_mkdir(request: Request):
    _require_bearer(request)
    chat_id = _file_scope(request)
    body = await _file_body(request)
    target = _resolve(state.cwd.get(chat_id, "/root"), str(body.get("path", "")))
    result = await _file_exec(chat_id, f"mkdir -p {_q(target)}")
    if result["exit"] != 0:
        raise HTTPException(status_code=400, detail=result.get("stderr") or "mkdir failed")
    return {"path": target}


@app.post("/files/move")
async def files_move(request: Request):
    _require_bearer(request)
    chat_id = _file_scope(request)
    body = await _file_body(request)
    cwd = state.cwd.get(chat_id, "/root")
    src = _resolve(cwd, str(body.get("source", "")))
    dst = _resolve(cwd, str(body.get("destination", "")))
    cmd = (
        f"if [ ! -e {_q(src)} ]; then echo CXFERR_SRC; exit 2; fi; "
        f"if [ -e {_q(dst)} ]; then echo CXFERR_DST; exit 9; fi; "
        f"mv {_q(src)} {_q(dst)}"
    )
    result = await _file_exec(chat_id, cmd)
    out = result.get("stdout", "")
    if "CXFERR_SRC" in out:
        raise HTTPException(status_code=404, detail="Source path not found")
    if "CXFERR_DST" in out:
        raise HTTPException(status_code=409, detail="Destination already exists")
    if result["exit"] != 0:
        raise HTTPException(status_code=400, detail=result.get("stderr") or "move failed")
    return {"source": src, "destination": dst}


@app.delete("/files/delete")
async def files_delete(request: Request, path: str):
    _require_bearer(request)
    chat_id = _file_scope(request)
    target = _resolve(state.cwd.get(chat_id, "/root"), path)
    cmd = (
        f"if [ ! -e {_q(target)} ]; then echo CXFERR_NOTFOUND; exit 2; fi; "
        f"if [ -d {_q(target)} ]; then t=directory; else t=file; fi; "
        f"rm -rf {_q(target)}; echo CXT_$t"
    )
    result = await _file_exec(chat_id, cmd)
    out = result.get("stdout", "")
    if "CXFERR_NOTFOUND" in out:
        raise HTTPException(status_code=404, detail="Path not found")
    if result["exit"] != 0:
        raise HTTPException(status_code=400, detail=result.get("stderr") or "delete failed")
    etype = "directory" if "CXT_directory" in out else "file"
    return {"path": target, "type": etype}


def _parse_grep(stdout: str) -> list[dict]:
    results = []
    for line in stdout.splitlines():
        if not line or line.startswith("CX"):
            continue
        first = line.find(":")
        if first <= 0:
            continue
        second = line.find(":", first + 1)
        if second <= first:
            continue
        try:
            lineno = int(line[first + 1 : second])
        except ValueError:
            continue
        results.append({"path": line[:first], "line": lineno, "content": line[second + 1 :]})
    return results


@app.get("/files/search")
async def files_search(
    request: Request,
    query: str = "",
    path: str = ".",
    limit: int = 50,
    show_hidden: bool = False,
):
    _require_bearer(request)
    chat_id = _file_scope(request)
    if not isinstance(query, str) or not query:
        return {"results": []}
    target = _resolve(state.cwd.get(chat_id, "/root"), path)
    n = max(1, min(int(limit or 50), 500))
    result = await _file_exec(
        chat_id,
        f"grep -rn -i -F {_q(query)} {_q(target)} 2>/dev/null | head -n {n}",
    )
    return {"results": _parse_grep(result.get("stdout", ""))}


@app.get("/files/matches")
async def files_matches(request: Request, query: str = "", path: str = ".", offset: int = 0):
    _require_bearer(request)
    chat_id = _file_scope(request)
    if not isinstance(query, str) or not query:
        return {"results": []}
    target = _resolve(state.cwd.get(chat_id, "/root"), path)
    result = await _file_exec(
        chat_id,
        f"grep -rn -i -F {_q(query)} {_q(target)} 2>/dev/null | head -n 200",
    )
    return {"results": _parse_grep(result.get("stdout", ""))}


@app.get("/files/glob")
async def files_glob(
    request: Request,
    pattern: str = "*",
    path: str = ".",
    type: str | None = None,
    max_results: int = 100,
):
    _require_bearer(request)
    chat_id = _file_scope(request)
    target = _resolve(state.cwd.get(chat_id, "/root"), path)
    pattern = str(pattern or "*")
    n = max(1, min(int(max_results or 100), 500))
    cmd = f"find {_q(target)} -maxdepth 3"
    if type in ("file", "directory"):
        cmd += f" -type {type}"
    cmd += f" -name {_q(pattern)} 2>/dev/null | head -n {n}"
    result = await _file_exec(chat_id, cmd)
    matches = [
        {"path": line, "name": os.path.basename(line)}
        for line in result.get("stdout", "").splitlines()
        if line and not line.startswith("CX")
    ]
    return {"path": target, "matches": matches}


def _parse_multipart(content_type: str, body: bytes) -> tuple[str, bytes] | None:
    """Extract the first file part from a multipart/form-data body (no deps)."""
    match = re.search(r"boundary=(?:\"([^\"]+)\"|([^;\s]+))", content_type or "")
    if match is None:
        return None
    boundary = match.group(1) or match.group(2)
    if not boundary:
        return None
    delim = b"--" + boundary.encode()
    for part in body.split(delim):
        if part in (b"", b"\r\n", b"\n", b"--", b"--\r\n", b"--\n"):
            continue
        part = part.lstrip(b"\r\n")
        header, sep, content = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        head = header.decode("utf-8", errors="replace")
        cd = re.search(
            r'Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:\s*;\s*filename="([^"]*)")?',
            head,
            re.IGNORECASE,
        )
        if cd is None or cd.group(2) is None:
            continue
        if content.endswith(b"\r\n"):
            content = content[:-2]
        return cd.group(2), content
    return None


_UPLOAD_OPENAPI = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["file"],
                    "properties": {
                        "file": {
                            "type": "string",
                            "format": "binary",
                            "description": "File content to write into the VM (multipart field 'file').",
                        }
                    },
                }
            }
        },
    }
}


@app.post("/files/upload", openapi_extra=_UPLOAD_OPENAPI)
async def files_upload(request: Request, directory: str = "."):
    _require_bearer(request)
    chat_id = _file_scope(request)
    body = await request.body()
    if len(body) > UPLOAD_MAX_BODY:
        raise HTTPException(status_code=413, detail="Upload too large")
    parsed = _parse_multipart(request.headers.get("content-type", ""), body)
    if parsed is None:
        raise HTTPException(status_code=400, detail="expected multipart file field 'file'")
    filename, data = parsed
    safe_name = os.path.basename(filename) or "upload.bin"
    target_dir = _resolve(state.cwd.get(chat_id, "/root"), directory)
    target_path = os.path.join(target_dir, safe_name)
    b64 = base64.b64encode(data).decode("ascii")
    chunks = [b64[i : i + 60000] for i in range(0, len(b64), 60000)] or [""]

    for i, chunk in enumerate(chunks):
        redir = ">" if i == 0 else ">>"
        cmd = (
            f"if [ ! -d {_q(target_dir)} ]; then mkdir -p {_q(target_dir)}; fi; "
            f"if printf '' | base64 -d >/dev/null 2>&1; then D='base64 -d'; else D='base64 -D'; fi; "
            f"printf '%s' '{chunk}' | $D {redir} {_q(target_path)}"
        )
        result = await _file_exec(chat_id, cmd)
        if result["exit"] != 0:
            raise HTTPException(status_code=400, detail=result.get("stderr") or "upload failed")

    return {"path": target_path, "size": len(data)}


# ---------------------------------------------------------------------------
# Execute API (TerminalDock "execute box") + port listing (PortList)
# Mirrors open-terminal's /execute and /ports contract. Our execs are
# synchronous request/reply inside the VM, so every process record completes
# before POST returns; GET /execute lists the chat's recent commands.
# ---------------------------------------------------------------------------

EXECUTE_MAX_RECORDS = 50
EXECUTE_MAX_TIMEOUT_SECONDS = 300.0

PORTS_SH = (
    "for f in /proc/net/tcp /proc/net/tcp6; do "
    "[ -r \"$f\" ] || continue; "
    "awk 'NR>1 && $4==\"0A\" { split($2,a,\":\"); if (a[2]!=\"0000\") print a[2] }' \"$f\"; "
    "done"
)


def _execute_records_chat(chat_id: str) -> list[dict]:
    return state.executes.setdefault(chat_id, [])


@app.get("/execute")
async def execute_list(request: Request):
    # Poll-safe: OWUI's TerminalDock may poll without X-Session-Id; that's
    # fine, just return no tracked processes for that poll.
    _require_bearer(request)
    chat_id = request.headers.get("x-session-id")
    if not chat_id:
        return []
    return [
        {
            "id": p["id"],
            "command": p["command"],
            "status": p["status"],
            "exit_code": p["exit_code"],
            "log_path": "",
        }
        for p in _execute_records_chat(chat_id)
    ]


_EXECUTE_OPENAPI = {
    "requestBody": {
        "required": True,
        "content": {
            "application/json": {
                "schema": {
                    "type": "object",
                    "required": ["command"],
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "Shell command to execute verbatim in the terminal.",
                        },
                        "cwd": {"type": "string", "description": "Working directory (relative to the session cwd)."},
                    },
                }
            }
        },
    }
}


@app.post("/execute", openapi_extra=_EXECUTE_OPENAPI)
async def execute_run(request: Request):
    _require_bearer(request)
    chat_id = _file_scope(request)
    body = await _file_body(request)
    command = body.get("command", "")
    if not isinstance(command, str) or not command.strip():
        raise HTTPException(status_code=400, detail="empty command")

    cwd = state.cwd.get(chat_id, "/root")
    if isinstance(body.get("cwd"), str) and body["cwd"]:
        cwd = _resolve(cwd, body["cwd"])

    try:
        wait = float(request.query_params.get("wait"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        wait = None
    if not wait or wait < 1:
        wait = 30.0
    wait = min(wait, EXECUTE_MAX_TIMEOUT_SECONDS)

    process_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    try:
        result = await _vm_exec(chat_id, command, timeout_ms=int(wait * 1000), cwd=cwd)
        status, exit_code = "completed", result["exit"]
    except NoBrowserError:
        raise HTTPException(
            status_code=409,
            detail="The terminal VM is not open in a browser for this chat",
        ) from None
    except RelayInternalError:
        status, exit_code = "failed", -1
        result = {"stdout": "", "stderr": "command did not finish inside the VM"}

    output = []
    if result.get("stdout"):
        output.append({"type": "stdout", "data": result["stdout"]})
    if result.get("stderr"):
        output.append({"type": "stderr", "data": result["stderr"]})

    record = {
        "id": process_id,
        "command": command,
        "status": status,
        "exit_code": exit_code,
        "output": output,
        "truncated": False,
        "next_offset": len(output),
        "log_path": "",
    }
    records = _execute_records_chat(chat_id)
    records.append(record)
    del records[:-EXECUTE_MAX_RECORDS]
    return record


@app.get("/execute/{process_id}/status")
async def execute_status(request: Request, process_id: str):
    _require_bearer(request)
    chat_id = _file_scope(request)
    for p in _execute_records_chat(chat_id):
        if p["id"] == process_id:
            try:
                offset = max(0, int(request.query_params.get("offset") or 0))
            except ValueError:
                offset = 0
            return {
                **p,
                "output": p["output"][offset:],
                "next_offset": len(p["output"]),
            }
    raise HTTPException(status_code=404, detail="Process not found")


@app.post("/execute/{process_id}/input")
async def execute_input(request: Request, process_id: str):
    _require_bearer(request)
    chat_id = _file_scope(request)
    if any(p["id"] == process_id for p in _execute_records_chat(chat_id)):
        # Our execs are synchronous; the process has already exited.
        raise HTTPException(status_code=400, detail="Process has already exited")
    raise HTTPException(status_code=404, detail="Process not found")


@app.delete("/execute/{process_id}")
async def execute_kill(request: Request, process_id: str):
    _require_bearer(request)
    chat_id = _file_scope(request)
    records = _execute_records_chat(chat_id)
    for i, p in enumerate(records):
        if p["id"] == process_id:
            del records[i]
            return {"status": "killed"}
    raise HTTPException(status_code=404, detail="Process not found")


# ---------------------------------------------------------------------------
# Open-terminal session API (native "Open Terminal" panel)
# ---------------------------------------------------------------------------
# Mirrors the open-terminal REST contract the stock OpenWebUI v0.11 Web
# Terminal panel calls: POST /api/terminals to create a session, GET to list,
# WS /api/terminals/{session_id} (first-message auth + binary PTY frames) to
# attach, DELETE to tear down. Sessions are chat-scoped bookkeeping records:
# the client dials into the SAME chat's browser VM. The pty backend itself is
# the VM's interactive shell, so "pid" is informational (0) — nothing runs on
# this host.

TERMINAL_SESSIONS_MAX = 16


def _term_chat_id(request: Request) -> str | None:
    """Resolve the chat for a native-terminal request.

    Prefers the X-Session-Id header (OpenWebUI forwards it for every terminal
    request). Falls back to the single live VM when no header is present
    (poll-style/no-context probes), matching the /ports behavior.
    """
    chat_id = _file_chat_id(request)
    if chat_id is not None:
        return chat_id
    live = [s for s in state.sessions.values() if s.ws is not None]
    return live[0].chat_id if len(live) == 1 else None


def _term_scope(request: Request) -> str:
    chat_id = _term_chat_id(request)
    if chat_id is None:
        raise HTTPException(status_code=409, detail="no chat context for terminal session")
    return chat_id


@app.get("/api/terminals")
async def terminals_list(request: Request):
    _require_bearer(request)
    chat_id = _term_scope(request)
    items = [s for s in state.term_sessions.values() if s["chat_id"] == chat_id]
    items.sort(key=lambda s: (s["created_at"], s["id"]))
    return [{"id": s["id"], "created_at": s["created_at"], "pid": s["pid"]} for s in items]


@app.post("/api/terminals")
async def terminals_create(request: Request):
    _require_bearer(request)
    chat_id = _term_scope(request)
    sid = str(uuid.uuid4())
    record = {
        "id": sid,
        "chat_id": chat_id,
        "created_at": datetime.datetime.utcnow().isoformat() + "Z",
        "pid": 0,
    }
    chat_ids = [k for k, v in state.term_sessions.items() if v["chat_id"] == chat_id]
    while len(chat_ids) >= TERMINAL_SESSIONS_MAX:
        oldest = min(chat_ids, key=lambda k: (state.term_sessions[k]["created_at"], k))
        state.term_sessions.pop(oldest, None)
        chat_ids.remove(oldest)
    state.term_sessions[sid] = record
    log_info("terminal session created", id=sid, chat_id=chat_id)
    return {"id": sid, "created_at": record["created_at"], "pid": record["pid"]}


def _term_record(session_id: str, chat_id: str) -> dict:
    rec = state.term_sessions.get(session_id)
    if rec is None or rec["chat_id"] != chat_id:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"id": rec["id"], "created_at": rec["created_at"], "pid": rec["pid"]}


@app.get("/api/terminals/{session_id}")
async def terminals_get(request: Request, session_id: str):
    _require_bearer(request)
    chat_id = _term_scope(request)
    return _term_record(session_id, chat_id)


@app.delete("/api/terminals/{session_id}")
async def terminals_delete(request: Request, session_id: str):
    _require_bearer(request)
    chat_id = _term_scope(request)
    rec = state.term_sessions.pop(session_id, None)
    if rec is None or rec["chat_id"] != chat_id:
        raise HTTPException(status_code=404, detail="Session not found")
    log_info("terminal session deleted", id=session_id)
    return {"status": "deleted"}


@app.get("/ports")
async def ports_list(request: Request):
    # Poll-safe: OWUI's PortList polls /ports WITHOUT X-Session-Id. With no
    # chat context we degrade to a single live VM if exactly one is open
    # (multi-chat ambiguity -> empty), else empty.
    _require_bearer(request)
    chat_id = request.headers.get("x-session-id")
    if chat_id:
        sess = await state.get(chat_id)
        if sess is None or sess.ws is None:
            return {"ports": []}
    else:
        live = [s for s in state.sessions.values() if s.ws is not None]
        if len(live) != 1:
            return {"ports": []}
        sess = live[0]
        chat_id = sess.chat_id
    try:
        result = await _vm_exec(chat_id, PORTS_SH, timeout_ms=15000)
    except (NoBrowserError, RelayInternalError):
        return {"ports": []}
    ports = []
    for token_ in result.get("stdout", "").split():
        try:
            dec = int(token_, 16)
        except ValueError:
            continue
        if 1 <= dec <= 65535:
            ports.append({"port": dec, "pid": None, "process": None})
    ports.sort(key=lambda p: p["port"])
    return {"ports": ports}


_CMD_OPENAPI = {
    "requestBody": {
        "required": True,
        "content": {
            "application/json": {
                "schema": {
                    "type": "object",
                    "required": ["command"],
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "Shell command to execute verbatim in the terminal.",
                        },
                        "cwd": {"type": "string", "default": "/root", "description": "Working directory."},
                        "timeout_ms": {
                            "type": "integer",
                            "default": 30000,
                            "description": "Max run time in milliseconds (cap 300000).",
                        },
                        "chat_id": {
                            "type": "string",
                            "description": "Chat id; auto-filled from the session header when omitted.",
                        },
                    },
                }
            }
        },
    }
}


# The handler still parses the body by hand (Request), so FastAPI cannot infer
# the schema — it advertises an empty parameter set and any OpenAPI-derived tool
# (e.g. OpenWebUI's terminal-server tools) becomes uncallable. openapi_extra
# supplies the requestBody schema WITHOUT changing the parsing.
@app.post("/api/cmd", openapi_extra=_CMD_OPENAPI)
async def api_cmd(request: Request):
    _require_bearer(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid json")

    # chat_id from the body OR the proxy-injected X-Session-Id header, so an
    # agent tool only has to supply `command`.
    chat_id = _safe_chat_id(body.get("chat_id", "")) or _safe_chat_id(request.headers.get("x-session-id", ""))
    command = body.get("command", "")
    cwd = str(body.get("cwd", "/root"))[:1024]
    timeout_ms = body.get("timeout_ms", 30000)
    try:
        timeout_ms = max(1, min(int(timeout_ms), 300000))
    except (TypeError, ValueError):
        timeout_ms = 30000

    if chat_id is None:
        raise HTTPException(status_code=400, detail="missing or invalid chat_id")
    if not isinstance(command, str) or not command.strip():
        raise HTTPException(status_code=400, detail="empty command")
    if len(command) > MAX_COMMAND_LENGTH:
        raise HTTPException(status_code=400, detail="command too long")

    try:
        result = await _vm_exec(chat_id, command, timeout_ms=timeout_ms, cwd=cwd or None)
    except NoBrowserError:
        return JSONResponse(
            status_code=409,
            content={
                "ok": False,
                "error": "no_browser",
                "message": (
                    "The user's Local VM is not open. Ask the user to open "
                    "this chat in a browser and open the Browser VM terminal."
                ),
            },
        )
    except RelayInternalError:
        return JSONResponse(
            status_code=504,
            content={
                "ok": False,
                "error": "timeout",
                "message": f"Command did not finish within {timeout_ms}ms inside the Local VM.",
            },
        )

    return {
        "ok": True,
        **result,
    }


@app.get("/api/status")
async def api_status(chat_id: str = ""):
    chat_id = _safe_chat_id(chat_id)
    if chat_id is None:
        return {"ok": False, "error": "missing chat_id"}
    sess = await state.get(chat_id)
    up = sess is not None and sess.ws is not None
    return {"status": "up" if up else "down", "fresh": up, "client": sess.client if up and sess else ""}


@app.get("/healthz")
async def healthz():
    return PlainTextResponse("ok")


@app.get("/api/config")
async def api_config():
    return {
        "status": "ok",
        "project": "browser-vm",
        "fresh_vm": True,
        "browser_required": True,
        "note": "CheerpX/WebVM sandbox running in the user's browser tab; not executed on this host.",
    }


# ---------------------------------------------------------------------------
# WebSocket routes
# ---------------------------------------------------------------------------


@app.websocket("/vm")
async def ws_vm(ws: WebSocket, chat_id: str = "", token: str = ""):
    chat_id = _safe_chat_id(chat_id)
    if chat_id is None:
        await ws.accept()
        await ws.close(code=4003, reason="chat_id required")
        return
    # The `/vm-bridge/*` alias is the BROWSER leg and is already authenticated
    # by Cloudflare Access at the edge. A browser WebSocket cannot send an
    # Authorization header, and embedding the relay key in the URL would leak
    # it into page JS — so the browser sends no token and, with RELAY_WS_KEY
    # set, every connect was closed 4001 and reconnected in a tight loop
    # (registry stayed empty → the agent saw "no_browser"). Enforce the WS key
    # only on the direct `/vm` leg (server-to-server); trust CF Access on the
    # browser leg, which is the same trust boundary as the app itself.
    try:
        browser_leg = ws.url.path.endswith("/vm-bridge/vm")
    except Exception:
        browser_leg = False
    if RELAY_WS_KEY and not browser_leg:
        auth = ws.headers.get("authorization", "") or ""
        ok = token == RELAY_WS_KEY or auth == f"Bearer {RELAY_WS_KEY}"
        if not ok:
            await ws.accept()
            await ws.close(code=4001, reason="unauthorized")
            return
    await _vm_handler(ws, chat_id)


@app.websocket("/api/terminals/{session_id}")
async def ws_native_terminal(
    ws: WebSocket,
    session_id: str,
    x_session_id: str | None = Header(default=None),
    x_terminal_context_id: str | None = Header(default=None),
):
    await _native_handler(ws, session_id, x_session_id, x_terminal_context_id)


# ---------------------------------------------------------------------------
# Keepalive + stats endpoint for debugging
# ---------------------------------------------------------------------------


async def _keepalive_loop(loop: asyncio.AbstractEventLoop) -> None:
    while True:
        await asyncio.sleep(KEEPALIVE_SECONDS)
        async with state.lock:
            targets = [s for s in state.sessions.values() if s.ws is not None]
        for sess in targets:
            try:
                await sess.ws.send_text(json.dumps({"type": "ping"}))
            except Exception:
                pass


@app.get("/api/debug/registry")
async def debug_registry():
    async with state.lock:
        return {
            chat: {
                "client": s.client,
                "uptime_s": round(time.time() - s.since, 1),
                "pending": len(s.pending),
                "native_bridged": len(s.native_sessions),
            }
            for chat, s in state.sessions.items()
        }


# Browser-facing aliases: the loader reaches this relay through the
# cloudflared route `https://<host>/vm-bridge/*`, which forwards the path
# VERBATIM (no prefix stripping). So the browser leg arrives as
# `/vm-bridge/vm` while OpenWebUI's terminal server still talks to the bare
# root paths (`/api/terminals/…`, `/api/cmd`) on this same host. Register
# prefixed twins so both entry points work.
app.get("/vm-bridge/healthz")(healthz)
app.websocket("/vm-bridge/vm")(ws_vm)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )
    _attach_access_redaction()
    import uvicorn

    log.info("browser-vm relay starting on 0.0.0.0:%s", RELAY_PORT)
    uvicorn.run(app, host="0.0.0.0", port=RELAY_PORT, log_level="info")


if __name__ == "__main__":
    main()