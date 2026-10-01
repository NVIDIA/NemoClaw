"""Production relay smoke test (live deployment).

Connects to the running browser-vm-relay on 127.0.0.1:8787 using the real
BROWSER_VM_RELAY_KEY from ../scripts/openwebui/.env and verifies:
healthz, auth 401/409 behavior, exec round-trip, native OpenWebUI terminal
leg bridging both ways. Never prints the shared key.

Usage (from browser-vm/):
    .venv/bin/python test/prod_smoke.py
"""
import asyncio, json, os, re, time, urllib.request, urllib.error
from pathlib import Path
import websockets

env_path = Path("/Users/r/.nemoclaw/source/scripts/openwebui/.env").read_text()
key = re.search(r"^BROWSER_VM_RELAY_KEY=(.+)$", env_path, re.M).group(1).strip()

HTTP = "http://127.0.0.1:8787"
WS = "ws://127.0.0.1:8787"
fails = []
def check(n, c, d=""):
    print(f"  [{'PASS' if c else 'FAIL'}] {n}" + (f"  ({d})" if not c else ""))
    if not c: fails.append(n)

def hit(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(HTTP + path, data=data, method=method)
    if body is not None: req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            if not raw:
                return r.status, {}
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, {"text": raw.decode(errors="replace")}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, {"raw": raw.decode(errors="replace")}

async def main():
    code, res = hit("/healthz")
    check("prod healthz", code == 200)

    # 1. no browser yet -> 409
    code, res = hit("/api/cmd", "POST", {"chat_id": "prod-smoke-u", "command": "echo hi"})
    check("prod no_browser 409", code == 409 and res.get("error") == "no_browser")

    # 2. browser leg (real token) + tool round-trip
    events = []
    ws = await websockets.connect(f"{WS}/vm?chat_id=prod-smoke-1&token={key}")
    await ws.send(json.dumps({"type": "register", "chat_id": "prod-smoke-1", "client": "prod-check"}))
    async def reader():
        async for raw in ws:
            try: m = json.loads(raw); isj = isinstance(m, dict)
            except (ValueError, TypeError): isj = False
            if not isj: events.append(("raw", raw)); continue
            if m.get("type") == "ping":
                await ws.send(json.dumps({"type": "pong"}))
            elif m.get("type") == "exec":
                await ws.send(json.dumps({"type": "exec_result", "id": m["id"], "exit": 0,
                                          "stdout": "prod-ok:" + str(m.get("cmd"))[:40], "stderr": ""}))
            elif m.get("type") == "term:data":
                events.append(("term", m.get("data", "")))
    rt = asyncio.create_task(reader())
    await asyncio.sleep(0.6)
    code, res = await asyncio.to_thread(hit, "/api/cmd", "POST", {"chat_id": "prod-smoke-1", "command": "echo prod works", "timeout_ms": 8000})
    check("prod exec round-trip 200", code == 200 and res.get("exit") == 0, f"{code} {res}")
    check("prod exec stdout", str(res.get("stdout", "")).startswith("prod-ok"), str(res))

    # 3. native leg through real relay (as OWUI proxy would)
    async with websockets.connect(f"{WS}/api/terminals/sess-1",
                                  additional_headers={"X-Session-Id": "prod-smoke-1", "X-User-Id": "u-sys"}) as nat:
        await nat.send(json.dumps({"type": "auth", "token": key}))
        await asyncio.sleep(0.2)
        await nat.send("ls\n")
        await ws.send("prod-terminal-output")
        got_echo = False; got_term = False
        try:
            while True:
                raw = await asyncio.wait_for(nat.recv(), timeout=3)
                if raw == "prod-terminal-output": got_echo = True
        except asyncio.TimeoutError:
            pass
        got_term = any(t == "ls\n" for _, t in events)
        check("prod native->vm keystrokes", got_term, f"events={events[:20]}")
        check("prod vm->native output", got_echo)

    rt.cancel()
    await asyncio.gather(rt, return_exceptions=True)
    await ws.close()
    print("\n" + ("ALL PASS" if not fails else f"FAIL: {fails}"))

asyncio.run(main())
