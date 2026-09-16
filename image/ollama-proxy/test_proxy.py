# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import http.client
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from proxy import load_key, serve


class ProxyContract(unittest.TestCase):
    def test_auth_streaming_model_pin_and_external_ownership(self):
        calls = []
        digest = ["a" * 64]

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append((self.command, self.path, None))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {"models": [{"name": "qwen3:4b", "digest": digest[0], "size": 100}]}
                    ).encode()
                )

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                calls.append((self.command, self.path, self.headers.get("Authorization")))
                assert json.loads(body)["model"] == "qwen3:4b"
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'data: {"fixture":true}\n\ndata: [DONE]\n\n')

            def log_message(self, *_):
                pass

        upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = {
                "upstream": f"http://127.0.0.1:{upstream.server_port}/v1",
                "model": "qwen3:4b",
                "digest": "a" * 64,
            }
            proxy = serve(settings, root, "127.0.0.1", 0)
            worker = threading.Thread(target=proxy.serve_forever, daemon=True)
            worker.start()
            key = load_key(root)
            self.assertEqual(load_key(root), key)
            self.assertEqual((root / "inference-key").stat().st_mode & 0o777, 0o600)

            def request(path, body=None, token=key):
                conn = http.client.HTTPConnection("127.0.0.1", proxy.server_port, timeout=5)
                headers = (
                    {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
                    if token
                    else {}
                )
                conn.request("POST" if body is not None else "GET", path, body, headers)
                response = conn.getresponse()
                result = (response.status, response.read())
                conn.close()
                return result

            try:
                before = len(calls)
                self.assertEqual(request("/v1/models", token="wrong")[0], 401)
                self.assertEqual(len(calls), before)
                self.assertEqual(request("/api/pull", "{}")[0], 404)
                self.assertEqual(request("/v1/chat/completions", '{"model":"other"}')[0], 403)
                self.assertIn(b"qwen3:4b", request("/v1/models")[1])
                status, body = request("/v1/chat/completions", '{"model":"qwen3:4b","stream":true}')
                self.assertEqual(status, 200)
                self.assertIn(b"data: [DONE]", body)
                self.assertEqual(
                    [call for call in calls if call[0] == "POST"],
                    [("POST", "/v1/chat/completions", None)],
                )
                digest[0] = "b" * 64
                self.assertEqual(request("/v1/models")[0], 502)
            finally:
                proxy.shutdown()
                proxy.server_close()
                worker.join()
                upstream.shutdown()
                upstream.server_close()
                thread.join()
            (root / "inference-key").unlink()
            with self.assertRaises(RuntimeError):
                load_key(root)
