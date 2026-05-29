# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for scripts/docs-to-skills.py helpers."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "docs-to-skills.py"


def load_docs_to_skills():
    module_name = "docs_to_skills_test_module"
    spec = importlib.util.spec_from_file_location(module_name, SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def make_page(stem: str, *, content_type: str = "how_to", priority: int = 100) -> object:
    mod = load_docs_to_skills()
    page = mod.DocPage(path=Path(f"docs/example/{stem}.mdx"), raw="")
    page.content_type = content_type
    page.skill_priority = priority
    page.category = "example"
    return page


class DocsToSkillsHelpersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_docs_to_skills()

    def test_partition_skill_pages_uses_lowest_priority_value(self):
        high = make_page("high", priority=10)
        low = make_page("low", priority=50)
        lead, refs = self.mod.partition_skill_pages([low, high])
        self.assertEqual(lead.path.stem, "high")
        self.assertEqual([page.path.stem for page in refs], ["low"])

    def test_partition_grouped_skill_pages_uses_highest_priority_procedure(self):
        concept = make_page("overview", content_type="concept", priority=10)
        primary = make_page("lifecycle", content_type="how_to", priority=10)
        secondary = make_page("backup", content_type="how_to", priority=20)
        lead, refs = self.mod.partition_grouped_skill_pages(
            [secondary, concept, primary]
        )
        self.assertEqual(lead.path.stem, "lifecycle")
        self.assertEqual(
            {page.path.stem for page in refs},
            {"backup", "overview"},
        )

    def test_partition_grouped_skill_pages_reference_only_without_procedure(self):
        concept = make_page("overview", content_type="concept", priority=10)
        reference = make_page("commands", content_type="reference", priority=20)
        lead, refs = self.mod.partition_grouped_skill_pages([reference, concept])
        self.assertIsNone(lead)
        self.assertEqual([page.path.stem for page in refs], ["overview", "commands"])

    def test_partition_grouped_skill_pages_treats_get_started_as_procedure(self):
        quickstart = make_page("quickstart", content_type="get_started", priority=10)
        prereq = make_page("prerequisites", content_type="reference", priority=5)
        lead, refs = self.mod.partition_grouped_skill_pages([prereq, quickstart])
        self.assertEqual(lead.path.stem, "quickstart")
        self.assertEqual([page.path.stem for page in refs], ["prerequisites"])

    def test_group_individual_splits_procedure_concept_and_reference_pages(self):
        procedure = make_page("quickstart", content_type="get_started")
        concept = make_page("overview", content_type="concept")
        reference = make_page("commands", content_type="reference")
        troubleshooting = make_page("tool-calling", content_type="troubleshooting")
        groups = self.mod.group_individual(
            [procedure, concept, reference, troubleshooting]
        )
        self.assertEqual(groups["quickstart"], [procedure])
        self.assertEqual(groups["concept"], [concept])
        self.assertEqual(
            {page.path.stem for page in groups["reference"]},
            {"commands", "tool-calling"},
        )

    def test_group_by_directory_keeps_siblings_together(self):
        page_a = make_page("a")
        page_b = make_page("b")
        page_a.category = "get-started"
        page_b.category = "get-started"
        groups = self.mod.group_by_directory([page_a, page_b])
        self.assertEqual(len(groups["get-started"]), 2)

    def test_collapse_consecutive_blank_lines(self):
        text = "# Title\n\n\n## References\n"
        self.assertEqual(
            self.mod.collapse_consecutive_blank_lines(text),
            "# Title\n\n## References\n",
        )

    def test_append_markdown_section_avoids_duplicate_blank_lines(self):
        lines = ["# Title"]
        self.mod.append_markdown_section(lines, "## References")
        self.assertEqual(lines, ["# Title", "", "## References", ""])


if __name__ == "__main__":
    unittest.main()
