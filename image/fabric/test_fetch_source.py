# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Hermes source acquisition preserves integrity across HTTP rate limits."""

import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch
from urllib.error import HTTPError

from fetch_source import fetch

URL = "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/fixture"
SOURCE = b"verified source archive"
CHECKSUM = hashlib.sha256(SOURCE).hexdigest()


def response(body=SOURCE):
    return io.BytesIO(body)


def http_error(status):
    return HTTPError(URL, status, "fixture HTTP error", {}, io.BytesIO(b"error body"))


class FetchSource(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.destination = Path(directory.name) / "sources" / "hermes.tar.gz"

    def assert_no_archive(self):
        self.assertFalse(self.destination.exists())
        self.assertEqual(list(self.destination.parent.iterdir()), [])

    def test_a_rate_limit_then_success_publishes_only_verified_source(self):
        with (
            patch("fetch_source.urlopen", side_effect=[http_error(429), response()]),
            patch("fetch_source.time.sleep") as sleep,
        ):
            fetch(URL, CHECKSUM, self.destination)
        self.assertEqual(sleep.call_args_list, [call(15)])
        self.assertEqual(self.destination.read_bytes(), SOURCE)
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_three_rate_limits_fail_without_publishing_an_archive(self):
        with (
            patch(
                "fetch_source.urlopen",
                side_effect=[http_error(429), http_error(429), http_error(429), response()],
            ) as download,
            patch("fetch_source.time.sleep") as sleep,
        ):
            with self.assertRaises(HTTPError):
                fetch(URL, CHECKSUM, self.destination)
        self.assertEqual(download.call_count, 3)
        self.assertEqual(sleep.call_args_list, [call(15), call(30)])
        self.assert_no_archive()

    def test_other_http_errors_fail_without_retry(self):
        with patch("fetch_source.urlopen", side_effect=[http_error(403), response()]) as download:
            with self.assertRaises(HTTPError):
                fetch(URL, CHECKSUM, self.destination)
        self.assertEqual(download.call_count, 1)
        self.assert_no_archive()

    def test_a_checksum_mismatch_fails_without_retry_or_replacing_verified_source(self):
        self.destination.parent.mkdir()
        self.destination.write_bytes(SOURCE)
        with patch(
            "fetch_source.urlopen", side_effect=[response(b"error body"), response()]
        ) as get:
            with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
                fetch(URL, CHECKSUM, self.destination)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(self.destination.read_bytes(), SOURCE)
        self.assertEqual(list(self.destination.parent.iterdir()), [self.destination])

    def test_an_interrupted_download_removes_its_partial_archive(self):
        body = response()
        with (
            patch.object(body, "read", side_effect=[b"partial", TimeoutError("fixture timeout")]),
            patch("fetch_source.urlopen", return_value=body),
        ):
            with self.assertRaises(TimeoutError):
                fetch(URL, CHECKSUM, self.destination)
        self.assert_no_archive()

    def test_an_oversize_archive_is_rejected_and_removed(self):
        body = response()
        with (
            patch.object(body, "read", return_value=b"x" * (1024 * 1024)),
            patch("fetch_source.urlopen", return_value=body),
        ):
            with self.assertRaisesRegex(ValueError, "128 MiB"):
                fetch(URL, CHECKSUM, self.destination)
        self.assert_no_archive()
