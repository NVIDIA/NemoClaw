# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Image source downloads retry rate limits without retrying other HTTP failures."""

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch
from urllib.error import HTTPError

from fetch_source import fetch

URL = "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/fixture"


class FetchSource(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.destination = Path(directory.name) / "sources" / "hermes.tar.gz"

    def test_a_rate_limit_then_success_downloads_the_archive(self):
        with (
            patch(
                "fetch_source.urlopen",
                side_effect=[HTTPError(URL, 429, "", {}, None), io.BytesIO(b"source")],
            ),
            patch("fetch_source.time.sleep") as sleep,
        ):
            fetch(URL, self.destination)
        self.assertEqual(self.destination.read_bytes(), b"source")
        self.assertEqual(sleep.call_args_list, [call(15)])

    def test_terminal_http_errors_stop_at_the_retry_limit(self):
        for status, attempts, delays in [(403, 1, []), (429, 3, [call(15), call(30)])]:
            with (
                self.subTest(status=status),
                patch(
                    "fetch_source.urlopen", side_effect=HTTPError(URL, status, "", {}, None)
                ) as download,
                patch("fetch_source.time.sleep") as sleep,
            ):
                with self.assertRaises(HTTPError):
                    fetch(URL, self.destination)
                self.assertEqual(download.call_count, attempts)
                self.assertEqual(sleep.call_args_list, delays)
                self.assertFalse(self.destination.exists())
