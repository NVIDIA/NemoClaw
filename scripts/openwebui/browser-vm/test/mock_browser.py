#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# mock_browser — headless stand-in for the CheerpX pod in a browser tab.
# Registers as a browser VM on the relay and answers execs by running the
# command on THIS host (simulating the sandbox). Lets the whole relay + tool
# + native-terminal protocol be exercised end-to-end without a real browser.
#
#   python3 mock_browser.py --chat t1
#   (in another shell) python3 mock_tool.py --chat t1 --cmd "uname -a"

import argparse
import asyncio
import json
import subprocess

import websockets


async def run(cmd: str, cwd: str, timeout_ms: int) -> dict:
    """Simulate the VM executing a command (runs on the test host — MOCK ONLY).

    The real pod executes in a CheerpX sandbox; here we shell out. Runs off the
    event loop so WS ping/keepalive handling keeps working during execution.
    """
    def _exec() -> dict:
        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                cwd=cwd or None,
                capture_output=True,
                text=True,
                timeout=max(1, min(timeout_ms / 1000.0, 300)),
            )
            return {"ok": True, "exit": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
        except subprocess.TimeoutExpired as e:
            return {
                "ok": True,
                "exit": -1,
                "stdout": e.stdout or "",
                "stderr": (e.stderr or "") + "\n[mock] timed out",
            }
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "exit": -1, "stdout": "", "stderr": str(e)}

    return await asyncio.to_thread(_exec)


async def browser_loop(url: str, chat_id: str, token: str) -> None:
    uri = url.rstrip("/") + f"/vm?chat_id={chat_id}" + (f"&token={token}" if token else "")
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"type": "register", "chat_id": chat_id, "client": "mock-python"}))
        print(f"[mock-browser] registered chat_id={chat_id}")

        async for raw in ws:
            msg = None
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                pass

            if not isinstance(msg, dict) or "type" not in msg:
                # raw terminal frame forwarded from a bridged native session
                print(f"[mock-browser] termdata: {raw!r}")
                continue

            kind = msg["type"]
            if kind == "ping":
                await ws.send(json.dumps({"type": "pong"}))
            elif kind == "exec":
                res = await run(msg.get("cmd", ""), msg.get("cwd", ""), int(msg.get("timeout_ms") or 30000))
                await ws.send(
                    json.dumps(
                        {
                            "type": "exec_result",
                            "id": msg.get("id", ""),
                            "exit": res["exit"],
                            "stdout": res["stdout"],
                            "stderr": res["stderr"],
                        }
                    )
                )
            elif kind == "reset":
                print(f"[mock-browser] reset received id={msg.get('id')}")
                await ws.send(json.dumps({"type": "reset_ack", "id": msg.get("id", "")}))
            elif kind == "error":
                print(f"[mock-browser] relay error: {msg.get('message')}")
            else:
                print(f"[mock-browser] unhandled: {kind}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8787")
    ap.add_argument("--chat", required=True)
    ap.add_argument("--token", default="")
    args = ap.parse_args()
    asyncio.run(browser_loop(args.url, args.chat, args.token))


if __name__ == "__main__":
    main()