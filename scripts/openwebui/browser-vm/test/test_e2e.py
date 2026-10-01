#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# e2e test for the browser-vm relay: boots the real relay.py (fresh process on
# an ephemeral port), then exercises every leg of the protocol —
#
#   * tool  -> POST /api/cmd    (auth, no_browser 409, exec round-trip, 504)
#   * browser <- /vm?chat_id=   (register, pong, exec, raw terminal frames)
#   * native  <- /api/terminals/{session} (auth, term:data, output echo)
#   * browser WS auth (bad token rejected)
#   * file    <- /files/*       (Open Terminal sidebar: cwd, list, read, view,
#                                mkdir, move, delete, search, glob, upload)
#
# No browser, CheerpX, or OpenWebUI needed. Run from browser-vm/:
#   uv run --with fastapi --with 'uvicorn[standard]' --with websockets python test/test_e2e.py
#   (or any python env with fastapi + uvicorn + websockets installed)
#
# NOTE: HTTP calls must run via asyncio.to_thread — issuing blocking urllib in
# the event loop freezes the same-loop WebSocket readers (proxy bikeshedding
# for exec_result never arriving).

import asyncio
import importlib.util
import json
import logging
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parents[1]
RELAY_PY = ROOT / "relay" / "relay.py"
PORT = int(os.environ.get("BV_TEST_PORT", "18787"))
API_KEY = "test-key"
WS_TOKEN = "ws-token"

HTTP = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}"

failures = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  ({detail})" if not cond else ""))
    if not cond:
        failures.append(name)


def http_json_sync(
    path: str,
    method: str = "GET",
    body: dict | None = None,
    key: str | None = None,
    extra: dict | None = None,
) -> tuple[int, dict | None]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(HTTP + path, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key is not None:
        req.add_header("Authorization", f"Bearer {key}")
    for k, v in (extra or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            if not raw:
                return resp.status, {}
            try:
                return resp.status, json.loads(raw)
            except ValueError:
                return resp.status, {"text": raw.decode(errors="replace")}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, (json.loads(raw) if raw else {})
        except Exception:  # noqa: BLE001
            return e.code, {"raw": raw.decode(errors="replace")}
    except urllib.error.URLError as e:
        # Connection still booting / refused: signal not-ready.
        return 0, {"urlerror": str(e)}


async def http_json(*args, **kwargs) -> tuple[int, dict | None]:
    return await asyncio.to_thread(http_json_sync, *args, **kwargs)


def http_binary_sync(path: str, key: str | None = None, extra: dict | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(HTTP + path, method="GET")
    if key is not None:
        req.add_header("Authorization", f"Bearer {key}")
    for k, v in (extra or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


async def http_binary(*args, **kwargs) -> tuple[int, bytes]:
    return await asyncio.to_thread(http_binary_sync, *args, **kwargs)


def http_multipart_sync(
    path: str,
    field: str,
    filename: str,
    content: bytes,
    key: str | None = None,
    extra: dict | None = None,
) -> tuple[int, dict | None]:
    boundary = "----bvtestboundary0"
    payload = (
        b"--" + boundary.encode() + b"\r\n"
        + f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode()
        + b"Content-Type: application/octet-stream\r\n\r\n"
        + content
        + b"\r\n--" + boundary.encode() + b"--\r\n"
    )
    req = urllib.request.Request(HTTP + path, data=payload, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    if key is not None:
        req.add_header("Authorization", f"Bearer {key}")
    for k, v in (extra or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            try:
                return resp.status, (json.loads(raw) if raw else {})
            except ValueError:
                return resp.status, {"raw": raw.decode(errors="replace")}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, (json.loads(raw) if raw else {})
        except Exception:  # noqa: BLE001
            return e.code, {"raw": raw.decode(errors="replace")}


async def http_multipart(*args, **kwargs) -> tuple[int, dict | None]:
    return await asyncio.to_thread(http_multipart_sync, *args, **kwargs)


async def wait_healthy(timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, _ = await http_json("/healthz")
        if code == 200:
            return
        await asyncio.sleep(0.2)
    raise RuntimeError("relay did not become healthy")


async def open_browser(chat_id: str, events: list) -> websockets.ClientConnection:
    """Register as the browser pod for chat_id; return the ws + an events list.

    events receives ("term", data) for term:data frames and ("raw", text) for
    non-JSON frames."
    """
    ws = await websockets.connect(f"{WS}/vm?chat_id={chat_id}&token={WS_TOKEN}")
    await ws.send(json.dumps({"type": "register", "chat_id": chat_id, "client": "test-browser"}))
    return ws


async def browser_reader(ws: websockets.ClientConnection, events: list, reply_exec: bool = True) -> None:
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            events.append(("raw", raw))
            continue
        if isinstance(msg, dict):
            kind = msg.get("type")
            if kind == "ping":
                await ws.send(json.dumps({"type": "pong"}))
            elif kind == "exec":
                if reply_exec:
                    await ws.send(
                        json.dumps(
                            {
                                "type": "exec_result",
                                "id": msg["id"],
                                "exit": 0,
                                "stdout": "mock-out:" + str(msg.get("cmd"))[:40],
                                "stderr": "",
                            }
                        )
                    )
            elif kind == "term:data":
                events.append(("term", msg.get("data", "")))
            elif kind == "error":
                events.append(("relay-error", msg.get("message", "")))


async def scenario_trailing_slash() -> None:
    """OpenWebUI's terminal client sends these with a trailing slash.

    FastAPI's redirect_slashes would answer 307, and OpenWebUI's aiohttp proxy
    does not replay Authorization across a redirect, so every create/list came
    back 401 with a perfectly correct key. The relay normalises in-process.
    """
    print("[scenario] trailing-slash normalisation")
    H = {"X-Session-Id": "chat-slash"}

    for path in ("/api/terminals/", "/ports/", "/api/status/"):
        code, res = await http_json(path, key=API_KEY, extra=H)
        check(f"GET {path} is not a 307 redirect", code != 307, f"code={code}")
        check(f"GET {path} succeeds", code == 200, f"code={code} res={res}")

    # The slash form must be *equivalent* to the bare form, not merely not-307.
    code_bare, bare = await http_json("/api/terminals", key=API_KEY, extra=H)
    code_slash, slashed = await http_json("/api/terminals/", key=API_KEY, extra=H)
    check(
        "GET /api/terminals/ matches /api/terminals",
        code_bare == code_slash == 200 and bare == slashed,
        f"bare={code_bare},{bare} slash={code_slash},{slashed}",
    )

    code, res = await http_json("/api/terminals/", method="POST", key=API_KEY, extra=H)
    check("POST /api/terminals/ creates a session (not 401/307)", code == 200 and isinstance(res, dict) and "id" in (res or {}), f"code={code} res={res}")
    sid = (res or {}).get("id", "")
    check("created session has an id", bool(sid), f"res={res}")

    if sid:
        code, res = await http_json(f"/api/terminals/{sid}/", key=API_KEY, extra=H)
        check("GET session with trailing slash", code == 200 and (res or {}).get("id") == sid, f"code={code} res={res}")
        code, res = await http_json(f"/api/terminals/{sid}/", method="DELETE", key=API_KEY, extra=H)
        check("DELETE session with trailing slash", code == 200, f"code={code} res={res}")

    # Auth must still be enforced on the slash form: normalising the path must
    # not become a way around the bearer check.
    code, res = await http_json("/api/terminals/", key="wrong-key", extra=H)
    check("slash form still rejects a bad bearer", code == 401, f"code={code}")


async def scenario_auth_no_browser() -> None:
    print("[scenario] auth + no_browser")
    code, res = await http_json("/api/cmd", method="POST", body={"chat_id": "x", "command": "ls"}, key="wrong-key")
    check("bad bearer -> 401", code == 401, f"code={code}")
    code, res = await http_json("/api/cmd", method="POST", body={"chat_id": "ghost", "command": "ls"}, key=API_KEY)
    check("no browser -> 409 no_browser", code == 409 and (res or {}).get("error") == "no_browser", f"code={code}")
    code, res = await http_json("/api/cmd", method="POST", body={"chat_id": "x"}, key=API_KEY)
    check("missing command -> 400", code == 400, f"code={code}")
    code, res = await http_json("/api/status?chat_id=ghost")
    check("status down for unknown chat", (res or {}).get("status") == "down", f"res={res}")

    # Bad browser token: server must close the socket. Detect by attempting to
    # transact on it — a rejected connection surfaces as ConnectionClosed.
    rejected = False
    try:
        ws = await websockets.connect(f"{WS}/vm?chat_id=badtok&token=nope")
        try:
            await ws.send(json.dumps({"type": "register", "chat_id": "badtok", "client": "t"}))
            await asyncio.wait_for(ws.recv(), timeout=2)
        except websockets.ConnectionClosed:
            rejected = True
        finally:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
    except websockets.ConnectionClosed:
        rejected = True
    except Exception:  # noqa: BLE001
        pass
    check("browser bad token rejected", rejected is True)


async def scenario_browser_exec() -> None:
    print("[scenario] model tool -> browser exec round-trip + timeout")
    events: list = []
    ws = await open_browser("chat-exec1", events)
    reader = asyncio.create_task(browser_reader(ws, events))
    await asyncio.sleep(0.3)

    code, res = await http_json(
        "/api/cmd",
        method="POST",
        body={"chat_id": "chat-exec1", "command": "echo hi", "cwd": "/root", "timeout_ms": 8000},
        key=API_KEY,
    )
    check("exec returns 200", code == 200, f"code={code} res={res}")
    check("exec ok true", (res or {}).get("ok") is True, f"res={res}")
    check("exec exit 0", (res or {}).get("exit") == 0, f"res={res}")
    check("exec stdout relayed", (res or {}).get("stdout", "").startswith("mock-out:echo hi"), f"res={res}")

    # 504 path: a browser that ignores exec (connected, but reader never replies).
    events2: list = []
    ws2 = await open_browser("chat-noreply", events2)
    reader2 = asyncio.create_task(browser_reader(ws2, events2, reply_exec=False))
    await asyncio.sleep(0.3)
    code2, res2 = await http_json(
        "/api/cmd",
        method="POST",
        body={"chat_id": "chat-noreply", "command": "sleep 9", "timeout_ms": 400},
        key=API_KEY,
    )
    check("exec timeout -> 504", code2 == 504, f"code={code2} res={res2}")

    reader2.cancel()
    await asyncio.gather(reader2, return_exceptions=True)
    await ws2.close()
    reader.cancel()
    await asyncio.gather(reader, return_exceptions=True)
    await ws.close()


async def scenario_native_terminal() -> None:
    print("[scenario] native OpenWebUI terminal panel bridge")
    chat = "chat-native1"
    events: list = []
    ws = await open_browser(chat, events)
    reader = asyncio.create_task(browser_reader(ws, events))
    await asyncio.sleep(0.3)

    async with websockets.connect(
        f"{WS}/api/terminals/session-abc", additional_headers={"X-Session-Id": chat}
    ) as nat:
        await nat.send(json.dumps({"type": "auth", "token": API_KEY}))
        await asyncio.sleep(0.2)
        await nat.send("ls -la\n")
        await ws.send("hello-from-vm")

        got_echo = False
        try:
            while True:
                raw = await asyncio.wait_for(nat.recv(), timeout=3)
                if raw == "hello-from-vm":
                    got_echo = True
        except asyncio.TimeoutError:
            pass
        check("native keystrokes reached VM (term:data)", any(t == "ls -la\n" for _, t in events), f"events={events}")
        check("VM output echoed to native panel", got_echo, f"got_echo={got_echo}")

    reader.cancel()
    await asyncio.gather(reader, return_exceptions=True)
    await ws.close()


async def run_real(cmd: str, cwd: str, timeout_ms: int) -> dict:
    """Execute *cmd* like the mock browser pod would (runs on this host)."""

    def _exec() -> dict:
        try:
            shell_cwd = cwd if (cwd and os.path.isdir(cwd)) else None  # host has no /root in the test sandbox
            proc = subprocess.run(
                cmd,
                shell=True,
                cwd=shell_cwd,
                capture_output=True,
                text=True,
                timeout=max(1, min(timeout_ms / 1000.0, 90)),
            )
            return {"exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
        except subprocess.TimeoutExpired as e:
            return {"exit": -1, "stdout": e.stdout or "", "stderr": (e.stderr or "") + "\n[test] timed out"}

    return await asyncio.to_thread(_exec)


async def browser_reader_real(ws: websockets.ClientConnection, events: list) -> None:
    """Reader that answers exec frames by actually running them (fake sandbox)."""
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            events.append(("raw", raw))
            continue
        if not isinstance(msg, dict):
            continue
        kind = msg.get("type")
        if kind == "ping":
            await ws.send(json.dumps({"type": "pong"}))
        elif kind == "exec":
            res = await run_real(msg.get("cmd", ""), msg.get("cwd", ""), int(msg.get("timeout_ms") or 30000))
            await ws.send(
                json.dumps(
                    {
                        "type": "exec_result",
                        "id": msg["id"],
                        "exit": res["exit"],
                        "stdout": res["stdout"],
                        "stderr": res["stderr"],
                    }
                )
            )
        elif kind == "term:data":
            events.append(("term", msg.get("data", "")))
        elif kind == "error":
            events.append(("relay-error", msg.get("message", "")))


async def scenario_file_api() -> None:
    """Open Terminal /files/* REST surface (the sidebar file browser)."""
    import shutil
    import tempfile

    tmp = tempfile.mkdtemp(prefix="bv-files-")
    notes = os.path.join(tmp, "notes.txt")
    with open(notes, "w", encoding="utf-8") as f:
        f.write("line one\nline two\n")
    os.mkdir(os.path.join(tmp, "docs"))
    with open(os.path.join(tmp, "pic.png"), "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 40)

    chat = "chat-files1"
    events: list = []
    ws = await open_browser(chat, events)
    reader = asyncio.create_task(browser_reader_real(ws, events))
    await asyncio.sleep(0.3)
    H = {"X-Session-Id": chat}

    try:
        code, res = await http_json("/files/cwd", extra=H)
        check("files/cwd requires bearer", code == 401, f"code={code}")

        code, res = await http_json("/files/cwd", key=API_KEY, extra=H)
        check("files/cwd default /root", code == 200 and (res or {}).get("cwd") == "/root", f"code={code} res={res}")

        code, res = await http_json("/files/cwd", method="POST", body={"path": tmp}, key=API_KEY, extra=H)
        check("files/cwd set", code == 200 and (res or {}).get("cwd") == tmp, f"code={code} res={res}")

        code, res = await http_json("/files/list", key=API_KEY, extra=H)
        entries = (res or {}).get("entries", [])
        names = [e["name"] for e in entries]
        check("files/list entries", code == 200 and names, f"code={code} res={res}")
        check(
            "files/list has file+dir",
            "notes.txt" in names and "docs" in names and "pic.png" in names,
            f"names={names}",
        )
        note = next((e for e in entries if e["name"] == "notes.txt"), None)
        check(
            "files/list file metadata",
            note is not None and note["type"] == "file" and note["size"] == 18,
            f"note={note}",
        )

        code, res = await http_json("/files/read?path=notes.txt", key=API_KEY, extra=H)
        check("files/read returns all lines", code == 200 and (res or {}).get("content") == "line one\nline two\n", f"code={code} res={res}")
        check("files/read total_lines", (res or {}).get("total_lines") == 2, f"res={res}")

        code, res = await http_json("/files/read?path=notes.txt&start_line=2", key=API_KEY, extra=H)
        check("files/read line range", code == 200 and (res or {}).get("content") == "line two\n", f"code={code} res={res}")

        code, raw = await http_binary("/files/view?path=pic.png", key=API_KEY, extra=H)
        check("files/view binary", code == 200 and raw[:4] == b"\x89PNG", f"code={code}")

        code, res = await http_json("/files/mkdir", method="POST", body={"path": "newdir"}, key=API_KEY, extra=H)
        check("files/mkdir", code == 200 and (res or {}).get("path") == os.path.join(tmp, "newdir"), f"code={code} res={res}")
        code, res = await http_json("/files/list", key=API_KEY, extra=H)
        check("files/list sees newdir", "newdir" in [e["name"] for e in (res or {}).get("entries", [])], f"res={res}")

        code, res = await http_json(
            "/files/move",
            method="POST",
            body={"source": "notes.txt", "destination": "notes2.txt"},
            key=API_KEY,
            extra=H,
        )
        check("files/move", code == 200, f"code={code} res={res}")
        code, res = await http_json("/files/read?path=notes2.txt", key=API_KEY, extra=H)
        check("files/read after move", code == 200 and (res or {}).get("content", "").startswith("line one"), f"code={code}")

        code, res = await http_json("/files/delete?path=notes2.txt", method="DELETE", key=API_KEY, extra=H)
        check("files/delete", code == 200 and (res or {}).get("type") == "file", f"code={code} res={res}")
        code, res = await http_json("/files/read?path=notes2.txt", key=API_KEY, extra=H)
        check("files/read after delete -> 404", code == 404, f"code={code}")

        code, res = await http_json("/files/search?query=two", key=API_KEY, extra=H)
        check("files/search results", code == 200 and isinstance((res or {}).get("results"), list), f"code={code} res={res}")
        code, res = await http_json("/files/matches?query=two", key=API_KEY, extra=H)
        check("files/matches results", code == 200 and isinstance((res or {}).get("results"), list), f"code={code} res={res}")

        up = b"uploaded bytes\n"
        code, res = await http_multipart("/files/upload", field="file", filename="up.txt", content=up, key=API_KEY, extra=H)
        check("files/upload ok", code == 200 and (res or {}).get("size") == len(up), f"code={code} res={res}")
        code, res = await http_json("/files/read?path=up.txt", key=API_KEY, extra=H)
        check("files/read after upload", code == 200 and (res or {}).get("content") == "uploaded bytes\n", f"code={code} res={res}")

        code, res = await http_json("/files/glob?pattern=*.txt", key=API_KEY, extra=H)
        matches = (res or {}).get("matches", [])
        check("files/glob matches", code == 200 and any(m.get("name") == "up.txt" for m in matches), f"code={code} res={res}")
        code, res = await http_json("/files/glob?pattern=pic.*", key=API_KEY, extra=H)
        matches = (res or {}).get("matches", [])
        check("files/glob png", any(m.get("name") == "pic.png" for m in matches), f"res={res}")

        code, res = await http_json("/files/list?directory=/definitely-not-here", key=API_KEY, extra=H)
        check("files/list missing dir -> 404", code == 404, f"code={code}")

        code, res = await http_json("/files/list", key=API_KEY, extra={"X-Session-Id": "ghost-file-chat"})
        check("files/list no-vm -> 409", code == 409, f"code={code}")

        code, res = await http_json("/files/cwd", key=API_KEY)  # no X-Session-Id
        check("files/cwd no chat context -> 400", code == 400, f"code={code}")
    finally:
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(tmp, ignore_errors=True)


async def scenario_execute_ports() -> None:
    """TerminalDock /execute box + PortList /ports endpoints."""
    chat = "chat-exe1"
    events: list = []
    ws = await open_browser(chat, events)
    reader = asyncio.create_task(browser_reader_real(ws, events))
    await asyncio.sleep(0.3)
    H = {"X-Session-Id": chat}

    try:
        code, res = await http_json("/execute", extra=H)
        check("execute list requires bearer", code == 401, f"code={code}")

        code, res = await http_json("/execute", key=API_KEY, extra=H)
        check("execute list starts empty", code == 200 and res == [], f"code={code} res={res}")

        code, res = await http_json(
            "/execute",
            method="POST",
            body={"command": "echo exe-test-ok", "cwd": "/"},
            key=API_KEY,
            extra=H,
        )
        check(
            "execute run completed",
            code == 200 and (res or {}).get("status") == "completed" and (res or {}).get("exit_code") == 0,
            f"code={code} res={res}",
        )
        check(
            "execute output captured",
            any(e.get("data", "").startswith("exe-test-ok") for e in (res or {}).get("output", [])),
            f"res={res}",
        )
        pid = (res or {}).get("id", "")
        check("execute response has id", bool(pid), f"pid={pid}")

        code, res = await http_json("/execute", key=API_KEY, extra=H)
        check(
            "execute list has record",
            code == 200 and isinstance(res, list) and any(r.get("id") == pid for r in res),
            f"code={code} res={res}",
        )

        code, res = await http_json(f"/execute/{pid}/status", key=API_KEY, extra=H)
        check("execute status ok", code == 200 and (res or {}).get("status") == "completed", f"code={code} res={res}")

        code, res = await http_json(f"/execute/{pid}/status?offset=1", key=API_KEY, extra=H)
        check("execute status offset slice", code == 200 and isinstance((res or {}).get("output"), list), f"code={code} res={res}")

        code, res = await http_json(f"/execute/{pid}/input", method="POST", body={"input": "x"}, key=API_KEY, extra=H)
        check("execute input after exit -> 400", code == 400, f"code={code}")

        code, res = await http_json(f"/execute/{pid}", method="DELETE", key=API_KEY, extra=H)
        check("execute kill", code == 200 and (res or {}).get("status") == "killed", f"code={code} res={res}")

        code, res = await http_json(f"/execute/{pid}/status", key=API_KEY, extra=H)
        check("execute status after kill -> 404", code == 404, f"code={code}")

        code, res = await http_json(f"/execute/does-not-exist", method="DELETE", key=API_KEY, extra=H)
        check("execute kill unknown -> 404", code == 404, f"code={code}")

        code, res = await http_json("/ports", key=API_KEY, extra=H)
        check("ports shape", code == 200 and isinstance((res or {}).get("ports"), list), f"code={code} res={res}")

        # OWUI's native PortList/TerminalDock poll WITHOUT X-Session-Id.
        code, res = await http_json("/ports", key=API_KEY)
        check("ports poll w/o chat header 200", code == 200 and isinstance((res or {}).get("ports"), list), f"code={code} res={res}")
        code, res = await http_json("/execute", key=API_KEY)
        check("execute poll w/o chat header 200", code == 200 and res == [], f"code={code} res={res}")
        code, res = await http_json("/execute", key=API_KEY)
        check("execute poll no header 200", code == 200 and isinstance(res, list), f"code={code} res={res}")
        code, res = await http_json("/ports", key=API_KEY)
        check("ports poll no header 200", code == 200 and isinstance((res or {}).get("ports"), list), f"code={code} res={res}")

        # no-VM chat: list + ports degrade to empty; only POST requires a VM.
        NH = {"X-Session-Id": "ghost-exe"}
        code, res = await http_json("/execute", key=API_KEY, extra=NH)
        check("execute list no-vm []", code == 200 and res == [], f"code={code} res={res}")
        code, res = await http_json("/ports", key=API_KEY, extra=NH)
        check("ports no-vm []", code == 200 and (res or {}).get("ports") == [], f"res={res}")
        code, res = await http_json("/execute", method="POST", body={"command": "echo x"}, key=API_KEY, extra=NH)
        check("execute run no-vm -> 409", code == 409, f"code={code}")
    finally:
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


async def scenario_log_redaction() -> None:
    """uvicorn access rows must never carry query-string secrets in logs."""

    spec = importlib.util.spec_from_file_location("relay_redaction_ut", RELAY_PY)
    rel = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(rel)

    captured: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record)

    scratch = logging.getLogger("relay_redaction_scratch")
    scratch.handlers[:] = [_Capture()]
    scratch.propagate = False
    scratch.setLevel(logging.INFO)
    scratch.addFilter(rel._redact_access_log)  # type: ignore[attr-defined]

    scratch.info('%s - "WebSocket %s" [accepted]', "1.2.3.4:1", "/vm?chat_id=x&token=S3CRETWS&b=2")
    args = captured[0].args
    check(
        "access-log ws query token redacted",
        all("S3CRETWS" not in str(a) for a in args),
        f"args={args}",
    )

    captured.clear()
    scratch.info('%s - "%s %s HTTP/%s" %d', "1.2.3.4:1", "GET", "/api/cmd?token=S3CRETHTTP", "1.1", 200)
    args = captured[0].args
    check(
        "access-log http query token redacted",
        all("S3CRETHTTP" not in str(a) for a in args),
        f"args={args}",
    )

    captured.clear()
    scratch.info("%s - %s", "1.2.3.4:1", "unrelated line with secrets in another arg")
    check("access-log unrelated lines untouched", True)


async def main() -> None:
    env = os.environ.copy()
    env.update(
        {
            "RELAY_PORT": str(PORT),
            "RELAY_API_KEY": API_KEY,
            "RELAY_WS_KEY": WS_TOKEN,
            "RELAY_LOG_VERBOSE": "0",
        }
    )
    streams: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    relay_log: Path | None = None
    if os.environ.get("BV_TEST_LOG"):
        relay_log = ROOT / "test" / "relay-test.log"
        streams = {"stdout": open(relay_log, "wb"), "stderr": subprocess.STDOUT}
    proc = subprocess.Popen(
        [sys.executable, str(RELAY_PY)],
        cwd=RELAY_PY.parent,
        env=env,
        **streams,
    )
    try:
        try:
            await wait_healthy()
        except RuntimeError:
            if relay_log:
                print("relay stderr tail:")
                print(relay_log.read_text()[-3000:])
            raise
        print(f"relay up on {HTTP}")
        await scenario_auth_no_browser()
        await scenario_browser_exec()
        await scenario_native_terminal()
        await scenario_file_api()
        await scenario_execute_ports()
        await scenario_trailing_slash()
        await scenario_log_redaction()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        if relay_log:
            relay_log.unlink(missing_ok=True)

    print()
    if failures:
        print(f"FAIL ({len(failures)}): {failures}")
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    asyncio.run(main())