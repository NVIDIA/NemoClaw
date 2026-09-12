# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Execute generated metadata; real Windows/MXC import remains a separate gate."""

import importlib.util
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location(
    "generated_finder_metadata",
    os.environ.get(
        "NEMOCLAW_TEST_METADATA_BUILDER",
        str(Path(__file__).with_name("prepare-native-runtime.py")),
    ),
)
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class GeneratedFinderPaths(unittest.TestCase):
    def setUp(self):
        fixture = tempfile.TemporaryDirectory()
        self.addCleanup(fixture.cleanup)
        self.root = Path(fixture.name)
        self.source = self.root / "original/hermes-agent"
        self.target = self.root / "installed/hermes-agent"
        self.finder = (
            self.target / "venv/Lib/site-packages/__editable___hermes_finder.py"
        )
        self.finder.parent.mkdir(parents=True)
        package = self.target / "hermes_cli"
        package.mkdir()
        (package / "__init__.py").write_text("IDENTITY = 'owned-source'\n")
        self.input = (
            "from __future__ import annotations\n"
            f"MAPPING: dict[str, str] = { {'hermes_cli': str(self.source / 'hermes_cli')}!r}\n"
            f"NAMESPACES: dict[str, list[str]] = { {'hermes_plugins': [str(self.source / 'plugins')]}!r}\n"
        ).encode()

    def test_actual_generated_import_works_without_realpath(self):
        generated = metadata.relocate_finder(self.input, self.source)
        self.finder.write_bytes(generated)
        finder_spec = importlib.util.spec_from_file_location(
            "actual_finder", self.finder
        )
        finder = importlib.util.module_from_spec(finder_spec)
        with mock.patch.object(
            Path, "resolve", side_effect=PermissionError("GetFinalPath denied")
        ):
            finder_spec.loader.exec_module(finder)
            package_spec = importlib.util.spec_from_file_location(
                "actual_owned_hermes",
                Path(finder.MAPPING["hermes_cli"]) / "__init__.py",
            )
            package = importlib.util.module_from_spec(package_spec)
            package_spec.loader.exec_module(package)
        self.assertFalse(self.source.exists())
        self.assertEqual(
            finder.MAPPING, {"hermes_cli": str(self.target / "hermes_cli")}
        )
        self.assertEqual(
            finder.NAMESPACES, {"hermes_plugins": [str(self.target / "plugins")]}
        )
        self.assertEqual(package.IDENTITY, "owned-source")

    def test_generated_finder_refuses_relative_import_origin(self):
        generated = metadata.relocate_finder(self.input, self.source)
        with self.assertRaisesRegex(ImportError, "absolute installed path"):
            exec(generated, {"__file__": "venv/Lib/site-packages/finder.py"})

    def test_generated_finder_refuses_parent_traversal(self):
        generated = metadata.relocate_finder(self.input, self.source)
        with self.assertRaisesRegex(ImportError, "absolute installed path"):
            exec(generated, {"__file__": str(self.finder.parent / ".." / "finder.py")})

    def test_foreign_source_mapping_still_refused_before_generation(self):
        foreign = (
            "MAPPING: dict[str, str] = "
            + repr({"hermes_cli": str(self.root / "foreign" / "hermes_cli")})
            + "\n"
        ).encode()
        with self.assertRaisesRegex(
            metadata.AdaptationError, "declared source runtime"
        ):
            metadata.relocate_finder(foreign, self.source)


class CanonicalAdapterUpgrade(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.root = self.directory / "runtime"
        self.root.mkdir()
        self.old_hook = b"# previous reviewed hook fixture\n"
        self.new_hook = b"# new reviewed hook fixture\n"

        def digest(data):
            return hashlib.sha256(data).hexdigest()

        controller = self.directory / "controller"
        controller.mkdir()
        (controller / metadata.HOOK).write_bytes(self.new_hook)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(
            mock.patch.object(
                metadata, "__file__", str(controller / "prepare-native-runtime.py")
            )
        )
        self.stack.enter_context(
            mock.patch.object(
                metadata, "PREVIOUS_ADAPTER_SHA256", digest(self.old_hook)
            )
        )
        self.stack.enter_context(
            mock.patch.object(
                metadata, "UPGRADED_ADAPTER_SHA256", digest(self.new_hook)
            )
        )
        self.stack.enter_context(mock.patch.object(metadata.sys, "platform", "win32"))
        self.stack.enter_context(
            mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"})
        )
        generated = {}

        def put(relative, data, recorded=True):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            if recorded:
                generated[relative] = digest(data)

        home = (
            "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none"
        )
        put(home + "/python.exe", b"not executed", False)
        self.environments = ["hermes-agent/venv", "tools/browser-use"]
        for environment in self.environments:
            put(
                environment + "/pyvenv.cfg",
                ("home = " + str(self.root / home) + "\nrelocatable = true\n").encode(),
            )
        for relative in metadata.UPGRADE_HOOK_PATHS:
            put(relative, self.old_hook)
            put(
                str(Path(relative).with_name(metadata.PTH)),
                b"import nemoclaw_native_windows; nemoclaw_native_windows.install()\n",
            )
        site = "hermes-agent/venv/Lib/site-packages/"
        put(
            site + "__editable___hermes_finder.py",
            b"# retained generated finder fixture\n",
        )
        for alias in ["hermes", "hermes-acp"]:
            put("hermes-agent/venv/Scripts/" + alias + ".exe", b"not executed", False)
            put(
                "bin/" + alias + ".cmd",
                (
                    '@echo off\r\n"%~dp0..\\hermes-agent\\venv\\Scripts\\'
                    + alias
                    + '.exe" %*\r\n'
                ).encode(),
            )
        browser = "tools/browser-use/Lib/site-packages/browser_use-0.13.10.dist-info/"
        entry = b"[console_scripts]\nbu = browser_use.cli:main\n"
        put(browser + "METADATA", b"Name: browser-use\nVersion: 0.13.10\n", False)
        put(browser + "entry_points.txt", entry, False)
        put("tools/browser-use/Scripts/bu.exe", b"not executed", False)
        put(
            "bin/bu.cmd",
            b'@echo off\r\n"%~dp0..\\tools\\browser-use\\Scripts\\bu.exe" %*\r\n',
        )
        distribution = site + "hermes_agent-0.21.1.dist-info/"
        direct = (
            json.dumps(
                {
                    "dir_info": {"editable": True},
                    "url": (self.root / "hermes-agent").as_uri(),
                },
                indent=2,
            )
            + "\n"
        ).encode()
        put(distribution + "direct_url.json", direct)
        encoded = (
            base64.urlsafe_b64encode(hashlib.sha256(direct).digest())
            .decode()
            .rstrip("=")
        )
        put(
            distribution + "RECORD",
            (
                "hermes_agent-0.21.1.dist-info/direct_url.json,sha256="
                + encoded
                + ","
                + str(len(direct))
                + "\n"
            ).encode(),
        )
        put("untouched-runtime.bin", b"complete base retained", False)
        self.marker = {
            "schemaVersion": 1,
            "manager": "nemoclaw-windows",
            "hermesRevision": metadata.REVISION,
            "layoutVersion": 1,
            "pythonHomes": [home],
            "environments": self.environments,
            "environmentHomes": {name: home for name in self.environments},
            "browserUse": {
                "version": "0.13.10",
                "entryPointsSha256": digest(entry),
                "aliases": ["bu"],
            },
            "retiredEntrypoints": [{"path": "bin/bu.exe", "sha256": "1" * 64}],
            "startupAdapterSha256": digest(self.old_hook),
            "generatedFiles": generated,
        }
        marker_bytes = (json.dumps(self.marker, indent=2) + "\n").encode()
        put(metadata.MARKER, marker_bytes, False)
        self.stack.enter_context(
            mock.patch.object(metadata, "PREVIOUS_MARKER_SHA256", digest(marker_bytes))
        )

    def snapshot(self):
        return {
            p.relative_to(self.root).as_posix(): p.read_bytes()
            for p in self.root.rglob("*")
            if p.is_file()
        }

    def plan(self, **options):
        return metadata.prepare_plan(
            self.root,
            self.root,
            options.pop("target", self.root),
            self.environments,
            **options,
        )

    def test_upgrade_is_explicit_and_ci_only_before_target_relocation(self):
        before = self.snapshot()
        with self.assertRaises(metadata.AdaptationError):
            self.plan()
        for platform, ci, target in [
            ("linux", "true", self.root),
            ("win32", "false", self.root),
            ("win32", "true", self.directory / "installed"),
        ]:
            with (
                self.subTest(platform=platform, ci=ci, target=target),
                mock.patch.object(metadata.sys, "platform", platform),
                mock.patch.dict(os.environ, {"GITHUB_ACTIONS": ci}),
                self.assertRaisesRegex(metadata.AdaptationError, "complete CI copy"),
            ):
                self.plan(ci_upgrade_startup_adapter=True, target=target)
        self.assertEqual(self.snapshot(), before)

    def test_all_three_hooks_upgrade_metadata_retains_and_later_relocation_keeps_lineage(
        self,
    ):
        before = self.snapshot()
        changes, report = self.plan(ci_upgrade_startup_adapter=True)
        self.assertEqual(self.snapshot(), before)
        changed = {
            p.relative_to(self.root).as_posix()
            for p, data in changes.items()
            if before[p.relative_to(self.root).as_posix()] != data
        }
        self.assertEqual(changed, {*metadata.UPGRADE_HOOK_PATHS, metadata.MARKER})
        self.assertTrue(report["startupAdapterUpgradeApplied"])
        metadata.apply_plan(changes)
        for relative in metadata.UPGRADE_HOOK_PATHS:
            self.assertEqual((self.root / relative).read_bytes(), self.new_hook)
        marker = json.loads((self.root / metadata.MARKER).read_text())
        self.assertEqual(
            marker["retiredEntrypoints"], self.marker["retiredEntrypoints"]
        )
        self.assertEqual(
            marker["startupAdapterUpgrade"], metadata.adapter_upgrade_record()
        )
        for relative, data in before.items():
            if relative not in changed:
                self.assertEqual((self.root / relative).read_bytes(), data)
        later, receipt = self.plan(target=self.directory / "installed")
        self.assertFalse(receipt["startupAdapterUpgradeApplied"])
        self.assertEqual(
            receipt["startupAdapterUpgrade"], report["startupAdapterUpgrade"]
        )
        self.assertEqual(
            json.loads(later[self.root / metadata.MARKER])["startupAdapterUpgrade"],
            marker["startupAdapterUpgrade"],
        )
        with self.assertRaisesRegex(metadata.AdaptationError, "pinned old/new"):
            self.plan(ci_upgrade_startup_adapter=True)

    def test_any_old_hook_or_unrelated_recorded_metadata_tamper_is_refused(self):
        for relative in [
            *metadata.UPGRADE_HOOK_PATHS,
            "hermes-agent/venv/Lib/site-packages/__editable___hermes_finder.py",
        ]:
            path = self.root / relative
            old = path.read_bytes()
            path.write_bytes(old + b"# changed\n")
            before = self.snapshot()
            with (
                self.subTest(path=relative),
                self.assertRaisesRegex(
                    metadata.AdaptationError, "outside its recorded plan"
                ),
            ):
                self.plan(ci_upgrade_startup_adapter=True)
            self.assertEqual(self.snapshot(), before)
            path.write_bytes(old)

    def test_unknown_marker_new_hook_and_later_lineage_are_refused(self):
        marker = self.root / metadata.MARKER
        old = marker.read_bytes()
        marker.write_bytes(old + b" ")
        with self.assertRaisesRegex(metadata.AdaptationError, "pinned old/new"):
            self.plan(ci_upgrade_startup_adapter=True)
        marker.write_bytes(old)
        hook = Path(metadata.__file__).with_name(metadata.HOOK)
        hook.write_bytes(self.new_hook + b"# unknown\n")
        with self.assertRaisesRegex(metadata.AdaptationError, "pinned old/new"):
            self.plan(ci_upgrade_startup_adapter=True)
        hook.write_bytes(self.new_hook)
        changes, _ = self.plan(ci_upgrade_startup_adapter=True)
        metadata.apply_plan(changes)
        altered = json.loads(marker.read_text())
        altered["startupAdapterUpgrade"]["beforeSha256"] = "0" * 64
        marker.write_text(json.dumps(altered))
        with self.assertRaisesRegex(metadata.AdaptationError, "provenance changed"):
            self.plan()


if __name__ == "__main__":
    unittest.main()
