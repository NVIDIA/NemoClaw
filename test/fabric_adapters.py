# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Real packaged adapters against local TLS fixtures, inside an offline container."""

import asyncio
import http.server
import json
import os
import ssl
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, "/opt/nemoclaw")

HARNESS = sys.argv[1]
requests = []
MARKER = os.environ.get("FABRIC_FIXTURE_MARKER", "FABRIC_FIXTURE_OK")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond({"data": [{"id": "primary", "object": "model"}]})

    def respond(self, value):
        data = json.dumps(value).replace("FABRIC_FIXTURE_OK", MARKER).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        requests.append({"path": self.path, "body": body})
        text = "FABRIC_FIXTURE_OK"
        if "/responses" in self.path:
            item = {
                "id": "msg_fixture",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
            response = {
                "id": "resp_fixture",
                "object": "response",
                "status": "completed",
                "model": "primary",
                "output": [item],
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            }
            if not body.get("stream"):
                return self.respond(response)
            events = [
                (
                    "response.created",
                    {"response": {**response, "status": "in_progress", "output": []}},
                ),
                (
                    "response.output_item.added",
                    {"output_index": 0, "item": {**item, "status": "in_progress", "content": []}},
                ),
                (
                    "response.output_text.delta",
                    {"item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text},
                ),
                ("response.output_item.done", {"output_index": 0, "item": item}),
                ("response.completed", {"response": response}),
            ]
        elif "/messages" in self.path:
            response = {
                "id": "msg_fixture",
                "type": "message",
                "role": "assistant",
                "model": "primary",
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 5},
            }
            if not body.get("stream"):
                return self.respond(response)
            events = [
                ("message_start", {"message": {**response, "content": [], "stop_reason": None}}),
                (
                    "content_block_start",
                    {"index": 0, "content_block": {"type": "text", "text": ""}},
                ),
                (
                    "content_block_delta",
                    {"index": 0, "delta": {"type": "text_delta", "text": text}},
                ),
                ("content_block_stop", {"index": 0}),
                (
                    "message_delta",
                    {
                        "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                        "usage": {"output_tokens": 5},
                    },
                ),
                ("message_stop", {}),
            ]
        else:
            message = {"role": "assistant", "content": text}
            if HARNESS in ("mini-swe-agent", "nooa", "nooa-bench"):
                command = "printf FABRIC_FIXTURE_OK > /sandbox/workspace/tool-proof.txt"
                if HARNESS == "mini-swe-agent":
                    tool, args = (
                        "bash",
                        {
                            "command": command
                            + '; printf "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nFABRIC_FIXTURE_OK\\n"'
                        },
                    )
                else:
                    code = "await self.shell.run(" + repr(command) + ")\n"
                    if HARNESS == "nooa":
                        code += 'self.message("FABRIC_FIXTURE_OK")\nreturn_result(RespondResult(kind="DONE", explanation="FABRIC_FIXTURE_OK"))'
                    else:
                        code += 'return_result(TaskResult(solution_description="FABRIC_FIXTURE_OK", evidence="file written", command_to_verify="cat /sandbox/workspace/tool-proof.txt"))'
                    tool, args = "execute_python", {"code": code}
                message = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_" + str(len(requests)),
                            "type": "function",
                            "function": {"name": tool, "arguments": json.dumps(args)},
                        }
                    ],
                }

            response = {
                "id": "chat_fixture",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "primary",
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "finish_reason": "tool_calls" if "tool_calls" in message else "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                    "cost": 0,
                },
            }
            if not body.get("stream"):
                return self.respond(response)
            events = [
                (
                    None,
                    {
                        **response,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": message, "finish_reason": None}],
                    },
                ),
                (
                    None,
                    {
                        **response,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    },
                ),
            ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for seq, (event, data) in enumerate(events):
            if event:
                data = {"type": event, "sequence_number": seq, **data}
                self.wfile.write(f"event: {event}\n".encode())
            self.wfile.write(
                ("data: " + json.dumps(data).replace("FABRIC_FIXTURE_OK", MARKER) + "\n\n").encode()
            )
        if events[0][0] is None:
            self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


async def main():
    from fabric import configuration
    from nemo_fabric import Fabric, FabricConfig

    if HARNESS == "openclaw":
        # Container-only loopback alias exercises native SSRF checks without external networking.
        subprocess.run(["ip", "addr", "add", "8.8.4.4/32", "dev", "lo"], check=True)
        os.setgid(1000)
        os.setuid(1000)
    for d in ("/sandbox/tmp", "/sandbox/workspace", "/sandbox/artifacts"):
        Path(d).mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 443), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain("/certs/fixture.crt", "/certs/fixture.key")
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    model = (
        {
            "model": "qwen3:4b",
            "piModel": {
                "api": "openai-completions",
                "contextWindow": 8192,
                "maxTokens": 2048,
                "reasoning": False,
                "input": ["text"],
            },
        }
        if HARNESS == "pi"
        else None
    )
    if HARNESS == "pi" and os.environ.get("FABRIC_PI_CATALOG") == "1":
        model = {"model": "gpt-4o-mini"}
    api = os.environ.get("FABRIC_INFERENCE_API")
    inference = {"api": api, "tuning": {}} if api else None
    if HARNESS == "pi":
        inference = {
            "api": "openai-completions",
            "tuning": {},
            "connection": {
                "provider": "openai",
                "base_url": "https://inference.local/v1",
                "api_key_env": "NEMOCLAW_ANONYMOUS_API_KEY",
            },
        }
        os.environ["NEMOCLAW_INFERENCE_CONFIG"] = json.dumps(inference)
        os.environ["NEMOCLAW_ANONYMOUS_API_KEY"] = "unused"
    relay_enabled = HARNESS == "hermes" and os.environ.get("FABRIC_HERMES_RELAY") == "1"
    if inference and HARNESS == "openclaw":
        inference["provider"] = "fixture"
        inference["connection"] = {
            "provider": "openai",
            "model": "primary",
            "base_url": "https://inference.local/v1",
            "api_key_env": "NEMOCLAW_ANONYMOUS_API_KEY",
        }
        inference["tuning"] = {
            "contextWindow": 65536,
            "maxTokens": 2048,
            "reasoning": True,
            "reasoningEffort": "low",
        }
        os.environ["NEMOCLAW_ANONYMOUS_API_KEY"] = "unused"
    if inference and HARNESS == "hermes":
        inference["auth"] = {"method": "api-key", "providerRef": "fixture"}
        if relay_enabled:
            inference["observability"] = {"relay": {"enabled": True}}
    if os.environ.get("FABRIC_TEST_INTERFACES") == "1":
        inference = inference or {"api": "openai-completions", "tuning": {}}
        inference["interfaces"] = (
            {"dashboard": {"port": 18800, "bind": "127.0.0.1"}}
            if HARNESS == "openclaw"
            else {
                "api": {"port": 8643},
                "dashboard": {
                    "enabled": True,
                    "port": 18800,
                    "internalPort": 19120,
                    "tui": {"enabled": os.environ.get("FABRIC_HERMES_TUI") != "disabled"},
                },
            }
        )
        if HARNESS == "hermes" and os.environ.get("FABRIC_HERMES_DASHBOARD") == "disabled":
            inference["interfaces"]["dashboard"] = {"enabled": False}
    config = configuration("fixture", HARNESS, model, inference=inference)
    extra = ["--inference", json.dumps(inference)] if inference and HARNESS != "pi" else []
    env = dict(os.environ, NEMOCLAW_AGENT_NAME="fixture", NEMOCLAW_FABRIC_HARNESS=HARNESS)
    if inference:
        env["NEMOCLAW_INFERENCE_CONFIG"] = json.dumps(inference)
    host = subprocess.Popen([sys.executable, "/opt/nemoclaw/fabric.py", "serve"], env=env)
    try:
        for _ in range(90):
            if host.poll() is not None:
                raise AssertionError(f"host exited with status {host.returncode}")
            if Path("/sandbox/fabric.sock").exists():
                break
            await asyncio.sleep(1)
        if HARNESS == "pi":
            subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "configure",
                    "fixture",
                    "pi",
                    json.dumps(model),
                ],
                check=True,
            )
        startup_requests = len(requests)
        interface_token = (
            Path("/sandbox/.openclaw/interface-token").read_text()
            if HARNESS == "openclaw" and os.environ.get("FABRIC_TEST_INTERFACES") == "1"
            else None
        )
        for _ in range(2):
            subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "check",
                    "fixture",
                    HARNESS,
                    *extra,
                ],
                check=True,
            )
        mismatch = subprocess.run(
            [sys.executable, "/opt/nemoclaw/fabric.py", "check", "wrong-name", HARNESS]
        )
        assert mismatch.returncode != 0, "readiness accepted different configuration"
        if interface_token:
            subprocess.run(
                [sys.executable, "/opt/nemoclaw/interfaces.py", "devices", "list"], check=True
            )
            token_path = Path("/sandbox/.openclaw/interface-token")
            token_path.write_text("0" * 64)
            invalid = subprocess.run(
                [sys.executable, "/opt/nemoclaw/fabric.py", "check", "fixture", HARNESS, *extra]
            )
            assert invalid.returncode != 0, "running gateway accepted incorrect access credential"
            token_path.write_text(interface_token)
            native_path = Path("/sandbox/.openclaw/openclaw.json")
            retained = native_path.read_text()
            changed = json.loads(retained)
            changed["gateway"]["controlUi"]["dangerouslyDisableDeviceAuth"] = True
            native_path.write_text(json.dumps(changed))
            invalid = subprocess.run(
                [sys.executable, "/opt/nemoclaw/fabric.py", "check", "fixture", HARNESS, *extra]
            )
            assert invalid.returncode != 0, "readiness accepted weakened device authentication"
            native_path.write_text(retained)
            subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "check",
                    "fixture",
                    HARNESS,
                    *extra,
                ],
                check=True,
            )
        assert len(requests) == startup_requests, "readiness made an inference request"
        if HARNESS == "hermes" and not relay_enabled:
            import urllib.error
            import urllib.request

            from hermes_adapter import interface_settings

            settings = interface_settings(inference)
            retained_token = Path("/sandbox/.hermes/interface-token").read_text()
            token_path = Path("/sandbox/.hermes/interface-token")
            token_path.write_text("0" * 64)
            invalid = subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "check",
                    "fixture",
                    "hermes",
                    *extra,
                ]
            )
            assert invalid.returncode != 0, "Hermes readiness accepted an incorrect token"
            token_path.write_text(retained_token)
            native_path = Path("/sandbox/.hermes/config.yaml")
            original = native_path.read_text()
            changed = json.loads(original)
            changed["model"]["base_url"] = "https://unexpected.invalid"
            native_path.write_text(json.dumps(changed))
            invalid = subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "check",
                    "fixture",
                    "hermes",
                    *extra,
                ]
            )
            assert invalid.returncode != 0 and json.loads(native_path.read_text()) == changed
            native_path.write_text(original)
            subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "check",
                    "fixture",
                    "hermes",
                    *extra,
                ],
                check=True,
            )

            try:
                urllib.request.urlopen(f"http://127.0.0.1:{settings['apiPort']}/v1/models")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            else:
                raise AssertionError("Hermes API accepted unauthenticated access")
            if settings["dashboard"]["enabled"]:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{settings['dashboard']['port']}/"
                ) as response:
                    assert response.status == 200 and b"<html" in response.read().lower()
                assert Path("/sandbox/.hermes/profiles/dashboard-home/config.yaml").exists()
                from aiohttp import ClientSession, WSServerHandshakeError

                access_token = (
                    Path("/sandbox/.hermes/profiles/dashboard-home/interface-token")
                    .read_text()
                    .strip()
                )
                async with ClientSession() as session:
                    url = f"http://127.0.0.1:{settings['dashboard']['port']}/api/ws?token={access_token}"
                    try:
                        async with session.ws_connect(
                            url, origin=f"http://127.0.0.1:{settings['dashboard']['port']}"
                        ) as websocket:
                            assert settings["dashboard"]["tui"]["enabled"], (
                                "disabled TUI accepted WebSocket"
                            )
                            await websocket.send_json(
                                {
                                    "jsonrpc": "2.0",
                                    "id": 1,
                                    "method": "session.create",
                                    "params": {},
                                }
                            )
                            while True:
                                event = await asyncio.wait_for(websocket.receive_json(), 20)
                                if event.get("id") == 1:
                                    assert "result" in event, event
                                    break
                    except WSServerHandshakeError as error:
                        assert not settings["dashboard"]["tui"]["enabled"] and error.status == 403
            else:
                import socket

                with socket.socket() as connection:
                    assert connection.connect_ex(("127.0.0.1", settings["dashboard"]["port"])) != 0

        if HARNESS == "hermes":
            probe = subprocess.run(
                [sys.executable, "/opt/nemoclaw/fabric.py", "probe", "fixture", "hermes"],
                capture_output=True,
                text=True,
                check=True,
            )
            assert json.loads(probe.stdout)["status"] == "succeeded"
        requests.clear()
        if HARNESS == "pi":
            # Changing the model must stop the old runtime before reconfiguration.
            import socket

            def status():
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.connect("/sandbox/fabric.sock")
                    connection.sendall(b'{"operation":"check"}\n')
                    return json.loads(connection.makefile().readline())

            first = status()["runtime_id"]
            subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "configure",
                    "fixture",
                    "pi",
                    json.dumps(model),
                ],
                check=True,
            )
            assert status()["runtime_id"] == first, "unchanged apply restarted Pi"
            alternate = {
                **model,
                "model": "a-second-custom-model" if "piModel" in model else "gpt-4.1-mini",
            }
            subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "prepare",
                    "fixture",
                    "pi",
                    json.dumps(alternate),
                ],
                check=True,
            )
            assert not status()["ready"], "old Pi runtime remained active before route change"
            subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "configure",
                    "fixture",
                    "pi",
                    json.dumps(alternate),
                ],
                check=True,
            )
            assert status()["runtime_id"] != first
            assert status()["config"]["models"]["default"]["model"] == alternate["model"]
            mismatch = subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "check",
                    "fixture",
                    "pi",
                    json.dumps(model),
                ]
            )
            assert mismatch.returncode != 0, "readiness accepted a different route model"
            subprocess.run(
                [
                    sys.executable,
                    "/opt/nemoclaw/fabric.py",
                    "configure",
                    "fixture",
                    "pi",
                    json.dumps(model),
                ],
                check=True,
            )
    finally:
        host.terminate()
        host.wait(timeout=30)
    if HARNESS == "pi":
        subprocess.run(
            [
                "node",
                "/opt/fabric-source/adapters/typescript/pi/dist/pi-probe.js",
                json.dumps(model),
            ],
            check=True,
        )
    runtime = await Fabric().start_runtime(FabricConfig.model_validate(config), base_dir="/sandbox")
    if interface_token:
        assert Path("/sandbox/.openclaw/interface-token").read_text() == interface_token, (
            "runtime restart rotated the retained credential"
        )
    if HARNESS == "hermes" and not relay_enabled:
        assert Path("/sandbox/.hermes/interface-token").read_text() == retained_token
    try:
        for _ in range(2):
            result = await runtime.invoke(input="Reply FABRIC_FIXTURE_OK, then finish the task.")
            mapping = result.to_mapping()
            assert mapping["runtime_id"] == runtime.runtime_id, mapping
            assert mapping["status"] == "succeeded", mapping
            assert "FABRIC_FIXTURE_OK" in json.dumps(mapping.get("output")), mapping
    finally:
        await runtime.stop()
        server.shutdown()
    if api:
        expected_path = {
            "openai-completions": "/chat/completions",
            "openai-responses": "/responses",
            "anthropic-messages": "/messages",
        }[api]
        inference_requests = [r for r in requests if r["path"] != "/api/show"]
        assert inference_requests and all(
            r["path"].endswith(expected_path) for r in inference_requests
        ), [r["path"] for r in requests]
    if HARNESS == "pi":
        assert requests and all(
            request["body"]["model"] == model["model"] for request in requests
        ), requests
    if HARNESS in ("mini-swe-agent", "nooa", "nooa-bench"):
        assert Path("/sandbox/workspace/tool-proof.txt").read_text() == "FABRIC_FIXTURE_OK"
    if relay_enabled:
        relay_dir = Path("/sandbox/artifacts/relay")
        event_files = sorted(relay_dir.glob("*/events.atof.jsonl"))
        trajectories = sorted(relay_dir.glob("*/trajectory-*.atif.json"))
        assert event_files and all(path.stat().st_size > 0 for path in event_files), (
            "Relay did not write ATOF events"
        )
        assert trajectories and all(path.stat().st_size > 0 for path in trajectories), (
            "Relay did not write ATIF trajectories"
        )
        artifact_text = "\n".join(path.read_text() for path in (*event_files, *trajectories))
        assert "fixture-only" not in artifact_text, "Relay artifacts leaked the model credential"


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[2] == "--serve-fixture":
        http.server.ThreadingHTTPServer((sys.argv[3], int(sys.argv[4])), Handler).serve_forever()
    else:
        asyncio.run(main())
