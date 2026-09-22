# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import unittest

from stack import Error, image_digest_aliases


class ImageLoadTests(unittest.TestCase):
    def test_digest_alias_requires_imported_image_content_to_match(self):
        digest = "sha256:" + "a" * 64
        rows = "REF TYPE DIGEST SIZE\n" + "docker.io/library/demo:test index " + digest + " 1MiB"
        self.assertEqual(
            image_digest_aliases(["demo@" + digest], rows),
            [("docker.io/library/demo:test", "docker.io/library/demo@" + digest)],
        )
        with self.assertRaises(Error):
            image_digest_aliases(["demo@sha256:" + "b" * 64], rows)

    def test_missing_digest_and_substituted_alias_fail_closed(self):
        with self.assertRaises(Error):
            image_digest_aliases([], "REF TYPE DIGEST")
        wanted = "sha256:" + "a" * 64
        rows = (
            "demo:test index " + wanted + "\n"
            "docker.io/library/demo@" + wanted + " index sha256:" + "b" * 64
        )
        with self.assertRaises(Error):
            image_digest_aliases(["demo@" + wanted], rows)


if __name__ == "__main__":
    unittest.main()
