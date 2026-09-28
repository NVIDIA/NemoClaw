# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Deterministic checks for the opt-in host inference preflight; no network calls."""

import contextlib
import io
import json
import socket
import ssl
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

import inference_check

KEY = "private-inference-test-key"


class Response(io.BytesIO):
    status = 200


class InferenceCheckTests(unittest.TestCase):
    def call(self, body=b'{"choices":[{}]}', error=None):
        opener = Mock()
        opener.open.side_effect = error
        opener.open.return_value = Response(body)
        with patch.object(
            inference_check.urllib.request, "build_opener", return_value=opener
        ) as build:
            inference_check.check_inference(KEY)
        return opener, build

    def test_success_matches_managed_model_probe_and_uses_verified_tls(self):
        opener, build = self.call()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://integrate.api.nvidia.com/v1/chat/completions")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + KEY)
        self.assertEqual(request.get_header("Content-type"), "application/json")
        payload = json.loads(request.data)
        self.assertEqual(
            payload,
            {
                "model": "nvidia/nemotron-3-ultra-550b-a55b",
                "messages": [{"role": "user", "content": "Reply OK."}],
                "max_tokens": 16,
                "stream": False,
            },
        )
        template = (
            Path(__file__).resolve().parents[2] / "examples/kubernetes/managed-development.yaml"
        ).read_text()
        self.assertIn("endpoint: " + request.full_url.removesuffix("/chat/completions"), template)
        self.assertIn("model: " + payload["model"], template)
        handlers = build.call_args.args
        tls = next(
            handler
            for handler in handlers
            if isinstance(handler, inference_check.urllib.request.HTTPSHandler)
        )
        self.assertEqual(tls._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(tls._context.check_hostname)
        self.assertLessEqual(opener.open.call_args.kwargs["timeout"], 80)

    def test_http_auth_errors_never_expose_body_header_key_or_exception(self):
        for status in [401, 403]:
            body = Mock()
            body.read.side_effect = AssertionError("error bodies must not be read")
            error = HTTPError("https://" + KEY, status, KEY, {"x-secret": KEY}, body)
            stdout, stderr = io.StringIO(), io.StringIO()
            with (
                self.subTest(status=status),
                contextlib.redirect_stdout(stdout),
                contextlib.redirect_stderr(stderr),
                self.assertRaises(inference_check.InferenceCheckError) as raised,
            ):
                self.call(error=error)
            self.assertIn("HTTP " + str(status), str(raised.exception))
            self.assertNotIn(KEY, str(raised.exception))
            self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
            body.read.assert_not_called()

    def test_redirect_handler_never_opens_redirect_destination(self):
        handler = inference_check.NoRedirect()
        parent = inference_check.urllib.request.build_opener(handler)
        parent.open = Mock()
        request = Request(inference_check.ENDPOINT, data=b"{}", headers={"Authorization": KEY})
        for status in [301, 302, 303, 307, 308]:
            with self.subTest(status=status), self.assertRaises(HTTPError):
                parent.error(
                    "http",
                    request,
                    io.BytesIO(),
                    status,
                    "redirect",
                    {"location": "https://other.invalid/" + KEY},
                )
        parent.open.assert_not_called()
        for status in [301, 302, 303, 307, 308]:
            with (
                self.subTest(status=status),
                self.assertRaisesRegex(inference_check.InferenceCheckError, "redirect"),
            ):
                self.call(error=HTTPError(inference_check.ENDPOINT, status, KEY, {}, None))

    def test_success_requires_bounded_json_and_nonempty_choices(self):
        for body in [
            b"broken",
            KEY.encode(),
            b"[]",
            b"null",
            b'{"choices":[]}',
            b'{"choices":{}}',
            b'{"choices":null}',
            b"\xff",
            b"{}",
        ]:
            with (
                self.subTest(body=body),
                self.assertRaises(inference_check.InferenceCheckError) as raised,
            ):
                self.call(body=body)
            self.assertNotIn(KEY, str(raised.exception))
        with self.assertRaisesRegex(inference_check.InferenceCheckError, "size limit"):
            self.call(body=b" " * (inference_check.MAX_RESPONSE_BYTES + 1))

    def test_response_read_is_capped_and_closed_on_success_or_failure(self):
        for value in [b'{"choices":[{}]}', b"invalid", TimeoutError(KEY)]:
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.read.return_value = value
            if isinstance(value, Exception):
                response.read.side_effect = value
            opener = Mock()
            opener.open.return_value = response
            with (
                self.subTest(value=value),
                patch.object(inference_check.urllib.request, "build_opener", return_value=opener),
            ):
                if value == b'{"choices":[{}]}':
                    inference_check.check_inference(KEY)
                else:
                    with self.assertRaises(inference_check.InferenceCheckError):
                        inference_check.check_inference(KEY)
            response.read.assert_called_once_with(inference_check.MAX_RESPONSE_BYTES + 1)
            response.__exit__.assert_called_once()

    def test_tls_dns_and_timeout_errors_use_static_diagnostics(self):
        for error, message in [
            (URLError(ssl.SSLCertVerificationError(KEY)), "TLS"),
            (URLError(socket.gaierror(KEY)), "DNS"),
            (URLError(TimeoutError(KEY)), "timed out"),
            (TimeoutError(KEY), "timed out"),
            (URLError(ConnectionRefusedError(KEY)), "network"),
            (RuntimeError(KEY), "failed"),
        ]:
            with (
                self.subTest(error=type(error).__name__),
                self.assertRaisesRegex(inference_check.InferenceCheckError, message) as raised,
            ):
                self.call(error=error)
            self.assertNotIn(KEY, str(raised.exception))

    def test_overall_deadline_also_bounds_a_stalled_transport(self):
        release = threading.Event()
        stopped = threading.Event()

        def stalled(_key):
            try:
                release.wait(1)
            finally:
                stopped.set()

        try:
            with (
                patch.object(inference_check, "TIMEOUT_SECONDS", 0.01),
                patch.object(inference_check, "_request", side_effect=stalled),
                self.assertRaisesRegex(inference_check.InferenceCheckError, "timed out"),
            ):
                inference_check.check_inference(KEY)
        finally:
            release.set()
            self.assertTrue(stopped.wait(1))

    def test_invalid_key_fails_before_transport(self):
        with patch.object(inference_check.urllib.request, "build_opener") as build:
            for key in ["", "contains space", "value\nvalue", "value\rvalue"]:
                with self.subTest(key=key), self.assertRaises(inference_check.InferenceCheckError):
                    inference_check.check_inference(key)
            build.assert_not_called()


if __name__ == "__main__":
    unittest.main()
