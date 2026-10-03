# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate native remote-subagent execution against a local Agent Protocol fixture."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from deepagents_code.agent import create_cli_agent, load_async_subagents
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage


class ScriptedModel(FakeMessagesListChatModel):
    """Replace only model inference; use the installed graph and network clients."""

    def bind_tools(self, tools, **kwargs):
        return self


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


async def invoke(root: Path, descriptors: list, agent_name: str):
    model = ScriptedModel(responses=[
        AIMessage(content="", tool_calls=[{
            "name": "start_async_task", "id": "fixture-call",
            "args": {"description": "fixture task input", "subagent_type": agent_name},
        }]),
        AIMessage(content="fixture complete"),
    ])
    graph, _ = create_cli_agent(
        model, "native-subagent-validation", cwd=root,
        system_prompt="Start the requested remote task once, then stop.",
        async_subagents=descriptors, interactive=False, auto_approve=True,
        enable_memory=False, enable_skills=False, enable_shell=False,
        enable_ask_user=False,
    )
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="Run the fixture task.")]},
        context={"auto_approve": True},
    )
    messages = [m for m in result["messages"] if isinstance(m, ToolMessage) and m.name == "start_async_task"]
    require(len(messages) == 1, "remote-subagent tool did not execute exactly once")
    return result, messages[0].content


def main():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, self.headers.get("X-Fixture-Key"), body))
            if self.path == "/valid/threads":
                status, payload = 200, {"thread_id": "fixture-thread"}
            elif self.path == "/valid/threads/fixture-thread/runs":
                status, payload = 200, {"run_id": "fixture-run"}
            elif self.path == "/failed/threads":
                status, payload = 403, {"detail": "fixture rejection"}
            else:
                status, payload = 404, {"detail": "unexpected fixture route"}
            encoded = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="dcode-native-subagents-") as directory:
            root = Path(directory)
            config = root / "config.toml"
            config.write_text(f'''
[async_subagents.valid]
description = "Successful fixture"
graph_id = "fixture-graph"
url = "http://127.0.0.1:{server.server_port}/valid"
headers = {{ X-Fixture-Key = "valid-fixture-header" }}
[async_subagents.failed]
description = "Rejected fixture"
graph_id = "fixture-graph"
url = "http://127.0.0.1:{server.server_port}/failed"
headers = {{ X-Fixture-Key = "failed-fixture-header" }}
[async_subagents.invalid]
description = "Missing the required graph identifier"
url = "http://127.0.0.1:{server.server_port}/must-not-run"
''')
            descriptors = load_async_subagents(config)
            require([d["name"] for d in descriptors] == ["valid", "failed"], "native descriptor validation changed")
            result, message = asyncio.run(invoke(root, descriptors, "valid"))
            require("Launched async subagent" in message, "valid remote task did not launch")
            require(result["async_tasks"]["fixture-thread"]["run_id"] == "fixture-run", "remote result was not recorded")
            require(len(requests) == 2, "valid task made unexpected requests")
            require([r[0] for r in requests] == ["/valid/threads", "/valid/threads/fixture-thread/runs"], "wrong remote endpoint")
            require(all(r[1] == "valid-fixture-header" for r in requests), "descriptor headers were not forwarded")
            require(requests[1][2]["assistant_id"] == "fixture-graph", "wrong remote graph")
            require(requests[1][2]["input"] == {"messages": [{"role": "user", "content": "fixture task input"}]}, "wrong remote task input")
            requests.clear()
            result, message = asyncio.run(invoke(root, descriptors, "failed"))
            require("Failed to launch async subagent" in message, "remote rejection was hidden")
            require(not result.get("async_tasks"), "rejected request registered a running task")
            require(len(requests) == 1 and requests[0][:2] == ("/failed/threads", "failed-fixture-header"), "remote rejection caused a follow-up or misrouted request")
            requests.clear()
            result, message = asyncio.run(invoke(root, descriptors, "invalid"))
            require("Unknown async subagent type" in message, "invalid descriptor was not rejected")
            require(not result.get("async_tasks") and not requests, "invalid descriptor caused a remote side effect")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        require(not thread.is_alive(), "remote-subagent fixture did not stop")


if __name__ == "__main__":
    main()
