# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Run an installed native adapter against owned local inference, without external APIs.

Run inside an owned image: python qualify_native.py ADAPTER_ID --settings '{...}'.
The installed native executable is real; only its inference endpoint is simulated.

Upstream: NVIDIA/NeMo-Fabric 24f068c895e5cbc30286bc743498be4e5014d658
tests/native/qualify.py, Apache-2.0. 2026-09-28: moved to NemoClaw, whose
image CI is its only caller; the usage line names this file, and the code
is formatted for NemoClaw's line length.
2026-09-28: use a Pi-known model identifier for the owned inference fixture.
"""

import argparse
import asyncio
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from nemo_fabric import Fabric, FabricConfig


class Inference(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"object": "list", "data": [{"id": "gpt-4.1-mini"}]}).encode())

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_error(404)
            return
        self.requests.append(request)
        assert self.headers.get("Authorization") == "Bearer fabric-native-key"
        response = {
            "id": "native-test",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-4.1-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "fabric-native-ok"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        self.send_response(200)
        self.send_header(
            "Content-Type",
            "text/event-stream" if request.get("stream") else "application/json",
        )
        self.end_headers()
        if request.get("stream"):
            response["object"] = "chat.completion.chunk"
            response["choices"] = [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": "fabric-native-ok"},
                    "finish_reason": None,
                }
            ]
            self.wfile.write(("data: " + json.dumps(response) + "\n\n").encode())
            response["choices"] = [{"index": 0, "delta": {}, "finish_reason": "stop"}]
            self.wfile.write(("data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n").encode())
        else:
            self.wfile.write(json.dumps(response).encode())


async def qualify(adapter_id, settings):
    os.environ["FABRIC_NATIVE_TEST_KEY"] = "fabric-native-key"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Inference)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="fabric-native-") as directory:
            config = FabricConfig.from_mapping(
                {
                    "metadata": {"name": "native-qualification"},
                    "harness": {"adapter_id": adapter_id, "settings": settings},
                    "models": {
                        "default": {
                            "provider": "openai",
                            "api": "openai-completions",
                            "model": "gpt-4.1-mini",
                            "api_key_env": "FABRIC_NATIVE_TEST_KEY",
                            "base_url": f"http://127.0.0.1:{server.server_port}/v1",
                        }
                    },
                }
            )
            fabric = Fabric()
            runtime = await fabric.start_runtime(config, base_dir=Path(directory))
            try:
                for prompt in ("Say fabric-native-ok.", "Repeat that response."):
                    result = await runtime.invoke(input=prompt)
                    assert result.status == "succeeded", result.to_mapping()
                    assert "fabric-native-ok" in json.dumps(result.to_mapping()["output"]), (
                        result.to_mapping()
                    )
                assert len(Inference.requests) >= 2, "native process did not use owned inference"
                print(
                    json.dumps(
                        {
                            "adapter_id": adapter_id,
                            "native_invocations": 2,
                            "inference_requests": len(Inference.requests),
                            "result": "passed",
                        }
                    )
                )
            finally:
                await runtime.stop()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("adapter_id")
    parser.add_argument("--settings", type=json.loads, default={})
    args = parser.parse_args()
    asyncio.run(qualify(args.adapter_id, args.settings))
