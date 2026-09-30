# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Native ownership and failure recovery for the pinned OpenClaw adapter patch."""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from openclaw_configuration import atomic_json, reconcile_configuration


class NativeConfiguration(unittest.TestCase):
    def test_owned_updates_preserve_bookkeeping_and_remove_obsolete_owned_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            initial = {"models": {"model": "first"}, "tools": {"allow": ["read"]}}
            reconcile_configuration(home, initial)
            path = home / "openclaw.json"
            actual = json.loads(path.read_text())
            actual["bookkeeping"] = {"retained": True}
            path.write_text(json.dumps(actual))
            changed = {"models": {"model": "second", "maxTokens": 2048}}
            reconcile_configuration(home, changed)
            self.assertEqual(
                json.loads(path.read_text()), {**changed, "bookkeeping": {"retained": True}}
            )
            before = path.stat().st_mtime_ns
            reconcile_configuration(home, copy.deepcopy(changed))
            self.assertEqual(path.stat().st_mtime_ns, before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            receipt = home / "fabric-owned-settings.json"
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("second", receipt.read_text())

    def test_foreign_edits_or_new_ownership_conflicts_preserve_all_files(self):
        for fault in ["owned-edit", "unowned-section", "receipt", "symlink"]:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                reconcile_configuration(home, {"models": "first"})
                path = home / "openclaw.json"
                receipt = home / "fabric-owned-settings.json"
                changed = {"models": "second"}
                if fault == "owned-edit":
                    path.write_text(json.dumps({"models": "foreign"}))
                elif fault == "unowned-section":
                    path.write_text(json.dumps({"models": "first", "tools": "foreign"}))
                    changed["tools"] = "proposed"
                elif fault == "receipt":
                    receipt.write_text("{}")
                else:
                    saved = home / "foreign.json"
                    path.rename(saved)
                    path.symlink_to(saved)
                before = (path.read_bytes(), receipt.read_bytes())
                with self.assertRaises(RuntimeError):
                    reconcile_configuration(home, changed)
                self.assertEqual((path.read_bytes(), receipt.read_bytes()), before)

    def test_proposed_settings_do_not_authorize_deleting_a_foreign_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            reconcile_configuration(home, {"models": "first", "tools": "owned"})
            path = home / "openclaw.json"
            path.write_text(json.dumps({"models": "second", "tools": "foreign"}))
            before = path.read_bytes()
            with self.assertRaises(RuntimeError):
                reconcile_configuration(home, {"models": "second"})
            self.assertEqual(path.read_bytes(), before)

    def test_unreceipted_files_must_match_and_interrupted_receipt_write_can_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / "openclaw.json"
            path.write_text(json.dumps({"models": "existing", "bookkeeping": True}))
            with self.assertRaises(RuntimeError):
                reconcile_configuration(home, {"models": "proposed"})
            reconcile_configuration(home, {"models": "existing"})

            def interrupt(target, value):
                if target.name == "fabric-owned-settings.json":
                    raise OSError("interrupted receipt write")
                atomic_json(target, value)

            with patch("openclaw_configuration.atomic_json", side_effect=interrupt):
                with self.assertRaises(OSError):
                    reconcile_configuration(home, {"models": "proposed"})
            reconcile_configuration(home, {"models": "proposed"})
            reconcile_configuration(home, {"models": "existing"})
            self.assertEqual(
                json.loads(path.read_text()), {"models": "existing", "bookkeeping": True}
            )
