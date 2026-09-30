# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Evaluate the bundled Hub downloader without downloading a model or using a GPU."""

import io
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import huggingface_hub
from huggingface_hub.file_download import http_get


class HubDownloadTest(unittest.TestCase):
    def test_expected_size_does_not_bound_bytes_written(self):
        payload = b"fixture" * 1024

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        with HTTPServer(("127.0.0.1", 0), Handler) as server:
            worker = threading.Thread(target=server.handle_request, daemon=True)
            worker.start()
            destination = io.BytesIO()
            try:
                with self.assertRaisesRegex(OSError, "Consistency check failed"):
                    http_get(
                        f"http://127.0.0.1:{server.server_port}/fixture",
                        destination,
                        expected_size=4,
                    )
                # Validation after download cannot preserve a bound on writes.
                self.assertEqual(destination.getvalue(), payload)
            finally:
                worker.join(timeout=5)


if __name__ == "__main__":
    print(f"Evaluating huggingface_hub {huggingface_hub.__version__}")
    unittest.main()
