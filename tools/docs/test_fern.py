# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("fern", Path(__file__).with_name("fern.py"))
fern = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fern)


class PublishingTests(unittest.TestCase):
    def test_main_docs_pin_must_be_immutable(self):
        for revision in ("main", "origin/main", "abcd", "../outside"):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                fern.validate_revision(revision)

    def test_main_import_adapts_absolute_snippets_without_editing_other_content(self):
        source = '<Markdown src="/../docs/_build/StarterPrompt.generated.mdx" />\n[legacy](/nemoclaw/latest/home)\n'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "docs/index.mdx"
            path.parent.mkdir()
            path.write_text(source)
            fern.adapt_main_snippets(Path(directory))
            self.assertEqual(path.read_text(), source.replace('/../docs/', '/_main/docs/'))

    def test_preview_ids_cannot_replace_main_previews(self):
        for identifier in ("pr-1", "main", "nemoclaw-v1-", "nemoclaw-v1/other"):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                fern.preview_url(identifier)
        self.assertEqual(
            fern.preview_url("nemoclaw-v1-pr-12"),
            "https://nvidia-preview-nemoclaw-v1-pr-12.docs.buildwithfern.com/nemoclaw",
        )

    @patch.dict("os.environ", {}, clear=True)
    def test_public_publish_requires_explicit_enablement_before_running_tools(self):
        with patch.object(fern, "prepare") as prepare, patch.object(fern, "run_fern") as run:
            with self.assertRaisesRegex(ValueError, "FERN_V1_PUBLIC_ENABLED"):
                fern.publish_public()
            prepare.assert_not_called()
            run.assert_not_called()

    def test_preview_rejects_failed_publish_even_if_output_contains_a_url(self):
        expected = fern.preview_url("nemoclaw-v1-pr-1")
        result = subprocess.CompletedProcess([], 1, f"Published docs to {expected}\n")
        with patch.object(fern, "prepare"), patch.object(fern, "run_fern", return_value=result):
            with self.assertRaises(RuntimeError):
                fern.publish_preview("nemoclaw-v1-pr-1")

    def test_preview_requires_a_matching_url_before_reporting_success(self):
        for output in ("", "Published docs to https://other.example/nemoclaw"):
            with self.subTest(output=output), patch.object(fern, "prepare"), patch.object(
                fern, "run_fern", return_value=subprocess.CompletedProcess([], 0, output)
            ), self.assertRaises(RuntimeError):
                fern.publish_preview("nemoclaw-v1-pr-1")

    def test_successful_preview_uses_only_staging_and_returns_its_own_url(self):
        expected = fern.preview_url("nemoclaw-v1-pr-1")
        result = subprocess.CompletedProcess([], 0, f"Published docs to {expected}/v1/overview\n")
        with patch.object(fern, "prepare"), patch.object(fern, "run_fern", return_value=result) as run:
            self.assertEqual(fern.publish_preview("nemoclaw-v1-pr-1"), expected + "/v1/overview")
            self.assertIn("--preview", run.call_args.args[0])
            self.assertIn(fern.STAGING, run.call_args.args[0])

    @patch.dict("os.environ", {"FERN_V1_PUBLIC_ENABLED": "true", "GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "v1.0.0"})
    def test_public_rejects_a_different_tag_commit_before_preparing(self):
        with patch.object(fern.subprocess, "run"), patch.object(fern.subprocess, "check_output", side_effect=[b"a" * 40, b"b" * 40]), patch.object(
            fern, "prepare"
        ) as prepare, self.assertRaisesRegex(ValueError, "tagged commit"):
            fern.publish_public()
        prepare.assert_not_called()

    @patch.dict("os.environ", {"FERN_V1_PUBLIC_ENABLED": "true", "GITHUB_REF_TYPE": "tag", "GITHUB_REF_NAME": "v1.0.0"})
    def test_public_rejects_commits_outside_v1_before_preparing(self):
        def git(arguments, **kwargs):
            if "merge-base" in arguments:
                raise subprocess.CalledProcessError(1, arguments)
        with patch.object(fern.subprocess, "check_output", return_value=b"a" * 40), patch.object(
            fern.subprocess, "run", side_effect=git
        ), patch.object(fern, "prepare") as prepare, self.assertRaises(subprocess.CalledProcessError):
            fern.publish_public()
        prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
