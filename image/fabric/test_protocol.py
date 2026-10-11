# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Parsing and request limits need neither Fabric nor a runtime host."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import bridge_protocol
from bridge_contract import REQUEST_LIMIT

CONFIG = {"metadata": {"name": "main"}, "harness": {"adapter_id": "vendor.new"}}


class CommandArguments(unittest.TestCase):
    def test_check_defaults_to_live_before_sending_the_request(self):
        self.assertEqual(
            bridge_protocol.parse_command(["check", "--agent", "main"]),
            {"operation": "check", "agent": "main", "level": "live"},
        )

    def test_named_files_are_read_without_touching_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "config.json"
            source.write_text(json.dumps(CONFIG))
            with patch("sys.stdin", new=Mock(read=Mock(side_effect=AssertionError("stdin")))):
                request = bridge_protocol.parse_command(
                    [
                        "configure",
                        "--agent",
                        "main",
                        "--config",
                        str(source),
                        "--expected-generation",
                        "opaque",
                    ]
                )
        self.assertEqual(
            request,
            {
                "operation": "configure",
                "agent": "main",
                "config": CONFIG,
                "expected_generation": "opaque",
            },
        )

    def test_unknown_duplicate_missing_and_conflicting_flags_are_safe_errors(self):
        for arguments in (
            [],
            ["SECRET"],
            ["check"],
            ["check", "--agent"],
            ["check", "--agent", "main", "--agent", "main"],
            ["check", "--agent", "main", "--config", "SECRET"],
            ["check", "--agent", "main", "--live", "--ready"],
            ["check", "--agent", "main", "--unknown"],
        ):
            with (
                self.subTest(arguments=arguments),
                self.assertRaises(bridge_protocol.ProtocolError) as error,
            ):
                bridge_protocol.parse_command(arguments)
            self.assertNotIn("SECRET", str(error.exception))

    def test_input_files_require_bounded_utf8_json_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            for content in (
                b"[]",
                b"null",
                b"{",
                b"{} {}",
                b"\xff",
                b'{"x":NaN}',
                b" " * (REQUEST_LIMIT + 1),
            ):
                path.write_bytes(content)
                with (
                    self.subTest(content=content[:10]),
                    self.assertRaises(bridge_protocol.ProtocolError),
                ):
                    bridge_protocol.parse_command(
                        ["invoke", "--agent", "main", "--input", str(path)]
                    )
            with self.assertRaises(bridge_protocol.ProtocolError):
                bridge_protocol.parse_command(
                    ["invoke", "--agent", "main", "--input", str(path / "missing")]
                )

    def test_dash_reads_one_object_from_stdin_for_each_input_flag(self):
        for operation, flag, field, value, extra in (
            ("validate", "--config", "config", CONFIG, []),
            ("configure", "--config", "config", CONFIG, ["--expected-generation", "opaque"]),
            ("invoke", "--input", "input", {"message": "hello"}, []),
        ):
            stdin = SimpleNamespace(
                buffer=io.BytesIO(json.dumps(value).encode()), isatty=lambda: False
            )
            with self.subTest(operation=operation), patch("sys.stdin", new=stdin):
                request = bridge_protocol.parse_command(
                    [operation, "--agent", "main", flag, "-", *extra]
                )
            self.assertEqual(request[field], value)
            self.assertEqual(stdin.buffer.read(), b"")

    def test_stdin_requires_one_bounded_object_and_never_reads_a_terminal(self):
        for content in (
            b"",
            b"[]",
            b"{} {}",
            b"\xff",
            b'{"x":NaN}',
            b'{"a":1,"a":2}',
            b" " * (REQUEST_LIMIT + 1),
        ):
            stdin = SimpleNamespace(buffer=io.BytesIO(content), isatty=lambda: False)
            with (
                self.subTest(content=content[:10]),
                patch("sys.stdin", new=stdin),
                self.assertRaises(bridge_protocol.ProtocolError) as error,
            ):
                bridge_protocol.parse_command(["invoke", "--agent", "main", "--input", "-"])
            self.assertEqual(error.exception.code, "invalid_input")
        unread = Mock(read=Mock(side_effect=AssertionError("terminal stdin was read")))
        for stdin in (None, SimpleNamespace(buffer=unread, isatty=lambda: True)):
            with (
                self.subTest(stdin=stdin),
                patch("sys.stdin", new=stdin),
                self.assertRaises(bridge_protocol.ProtocolError) as error,
            ):
                bridge_protocol.parse_command(["validate", "--agent", "main", "--config", "-"])
            self.assertEqual(error.exception.code, "invalid_input")

    def test_only_an_exact_dash_selects_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "-"
            path.write_text(json.dumps({"message": "file"}))
            with patch("sys.stdin", new=Mock(buffer=Mock(read=Mock(side_effect=AssertionError)))):
                request = bridge_protocol.parse_command(
                    ["invoke", "--agent", "main", "--input", str(path)]
                )
        self.assertEqual(request["input"], {"message": "file"})


class RequestLimits(unittest.TestCase):
    def test_request_limit_includes_its_newline(self):
        request = {"operation": "invoke", "agent": "main", "input": {"prompt": ""}}
        request["input"]["prompt"] = "a" * (REQUEST_LIMIT - len(bridge_protocol.encode(request)))
        self.assertEqual(len(bridge_protocol.encode(request)), REQUEST_LIMIT)
        bridge_protocol.validate_request(request)
        request["input"]["prompt"] += "a"
        with self.assertRaises(bridge_protocol.ProtocolError) as error:
            bridge_protocol.validate_request(request)
        self.assertEqual(error.exception.code, "request_too_large")


if __name__ == "__main__":
    unittest.main()
