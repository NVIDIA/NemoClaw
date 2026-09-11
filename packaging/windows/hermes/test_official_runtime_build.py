# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Portable behavior controls; actual Windows/MXC qualification is separate."""

import importlib.util
import copy
import contextlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.request
import zipfile
import sys
import types
import shutil
import subprocess


def load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, Path(__file__).with_name(filename)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load("official_builder", "provision-official-runtime.py")
freezer = load("official_freezer", "official-runtime-inventory.py")
openssl = load("official_openssl", "prepare-official-openssl.py")


class BuildControls(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_retained_ci_archive_must_match_the_same_immutable_bytes(self):
        file = self.root / "node-input.zip"
        file.write_bytes(b"verified-archive-fixture")
        record = {"size": file.stat().st_size, "sha256": builder.sha256(file)}
        self.assertEqual(builder.verified_build_archive(record, file), file.resolve())
        file.write_bytes(b"changed-archive--fixture")
        with self.assertRaisesRegex(ValueError, "immutable input"):
            builder.verified_build_archive(record, file)
        with self.assertRaisesRegex(ValueError, "immutable input"):
            builder.verified_build_archive({**record, "size": 0}, file)

    def test_complete_archive_keeps_licenses_and_dynamic_assets(self):
        archive = self.root / "input.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            handle.writestr("official/LICENSE", "official license")
            handle.writestr("official/plugins/custom/resource.json", '{"dynamic":true}')
            handle.writestr("official/runtime.d.ts", "export type Runtime = string")
        output = self.root / "output"
        builder.extract_complete(archive, output, "zip")
        self.assertEqual((output / "LICENSE").read_text(), "official license")
        self.assertEqual(
            json.loads((output / "plugins/custom/resource.json").read_text()),
            {"dynamic": True},
        )
        self.assertTrue((output / "runtime.d.ts").is_file())

    def test_archive_escape_is_rejected(self):
        archive = self.root / "input.zip"
        with zipfile.ZipFile(archive, "w") as handle:
            handle.writestr("official/../../outside", "bad")
        with self.assertRaisesRegex(ValueError, "unsafe path"):
            builder.extract_complete(archive, self.root / "output", "zip")
        self.assertFalse((self.root / "outside").exists())

    def test_real_child_output_and_exit_are_retained(self):
        result = builder.run_owned(
            sys.executable,
            ["-c", "print('OFFICIAL_CHILD_OK')"],
            os.environ.copy(),
            self.root,
            self.root,
            "child",
            timeout=3,
        )
        self.assertTrue(result["passed"])
        self.assertEqual(
            Path(result["stdout"]).read_text().strip(), "OFFICIAL_CHILD_OK"
        )

    def test_real_child_failure_keeps_the_primary_exit(self):
        with self.assertRaisesRegex(RuntimeError, "exited 7"):
            builder.run_owned(
                sys.executable,
                [
                    "-c",
                    "import sys; print('primary failure',file=sys.stderr); sys.exit(7)",
                ],
                os.environ.copy(),
                self.root,
                self.root,
                "failure",
                timeout=3,
            )
        receipt = json.loads((self.root / "failure.process.json").read_text())
        self.assertEqual(receipt["exitCode"], 7)
        self.assertIn("primary failure", Path(receipt["stderr"]).read_text())
        self.assertFalse(receipt["passed"])

    def test_real_hanging_child_is_bounded(self):
        with self.assertRaises(TimeoutError):
            builder.run_owned(
                sys.executable,
                ["-c", "import time;time.sleep(60)"],
                os.environ.copy(),
                self.root,
                self.root,
                "timeout",
                timeout=0.1,
            )
        receipt = json.loads((self.root / "timeout.process.json").read_text())
        self.assertIsNotNone(receipt["exitCode"])
        self.assertLess(receipt["elapsedSeconds"], 5)
        self.assertFalse(receipt["passed"])

    def test_windows_cleanup_uses_copied_environment_and_reaps_real_child(self):
        # The real Windows lane uses the actual System32 taskkill. The portable
        # lane executes the same Windows branch with an owned native-script
        # stand-in; it does not claim Windows API execution on another OS.
        for module, label in [(builder, "runtime"), (openssl, "openssl")]:
            with self.subTest(helper=label):
                root = self.root / label
                root.mkdir()
                environment = {key.upper(): value for key, value in os.environ.items()}
                patcher = contextlib.nullcontext()
                if os.name != "nt":
                    system = root / "system"
                    (system / "System32").mkdir(parents=True)
                    killer = system / "System32/taskkill.exe"
                    killer.write_text(
                        "#!" + sys.executable + "\n"
                        "import os,signal,sys\n"
                        "assert sys.argv[1]=='/PID' and sys.argv[3:]==['/T','/F']\n"
                        "os.kill(int(sys.argv[2]),signal.SIGKILL)\n",
                        encoding="utf-8",
                    )
                    killer.chmod(0o755)
                    environment["SYSTEMROOT"] = str(system)
                    patcher = mock.patch.object(
                        module,
                        "os",
                        types.SimpleNamespace(**{**vars(os), "name": "nt"}),
                    )
                with patcher, self.assertRaises(TimeoutError):
                    if label == "runtime":
                        module.run_owned(
                            sys.executable,
                            ["-c", "import time;time.sleep(60)"],
                            environment,
                            root,
                            root,
                            "uppercase",
                            timeout=0.1,
                        )
                    else:
                        module.run(
                            sys.executable,
                            ["-c", "import time;time.sleep(60)"],
                            root,
                            environment,
                            root,
                            "uppercase",
                            timeout=0.1,
                        )
                receipt = json.loads((root / "uppercase.process.json").read_text())
                self.assertIsNotNone(receipt["exitCode"])
                self.assertFalse(receipt["passed"])
                self.assertEqual(
                    receipt.get("cleanupErrors", receipt.get("cleanupFailures")), []
                )
                # This exact unlink failed on Windows while the original child
                # still held stderr. Do not ignore it or lengthen the timeout.
                (root / "uppercase.stderr.log").unlink()

    def test_windows_cleanup_root_is_case_insensitive_and_unambiguous(self):
        for module in (builder, openssl):
            with self.subTest(helper=module.__name__):
                expected = self.root / "System32/taskkill.exe"
                self.assertEqual(
                    module.windows_taskkill({"SYSTEMROOT": str(self.root)}), expected
                )
                self.assertEqual(
                    module.windows_taskkill({"SystemRoot": str(self.root)}), expected
                )
                with self.assertRaisesRegex(ValueError, "unambiguous"):
                    module.windows_taskkill(
                        {
                            "SystemRoot": str(self.root),
                            "SYSTEMROOT": str(self.root / "foreign"),
                        }
                    )
                with self.assertRaisesRegex(ValueError, "unambiguous"):
                    module.windows_taskkill({})

    def test_receipt_write_failure_does_not_replace_actual_child_failure(self):
        with mock.patch.object(
            builder, "write_json", side_effect=OSError("receipt-write-denied")
        ):
            with self.assertRaisesRegex(RuntimeError, "exited 7") as captured:
                builder.run_owned(
                    sys.executable,
                    ["-c", "import sys;sys.exit(7)"],
                    os.environ.copy(),
                    self.root,
                    self.root,
                    "receipt-failure",
                    timeout=3,
                )
        self.assertIn("receipt-write-denied", " ".join(captured.exception.__notes__))

    def test_local_mirror_serves_only_exact_pinned_paths(self):
        artifact = self.root / "artifact.zip"
        artifact.write_bytes(b"immutable archive control")
        with builder.artifact_mirror({"/exact.zip": artifact}) as endpoint:
            with urllib.request.urlopen(endpoint + "/exact.zip") as response:
                self.assertEqual(response.read(), artifact.read_bytes())
            with self.assertRaises(urllib.error.HTTPError) as captured:
                urllib.request.urlopen(endpoint + "/../artifact.zip")
            self.assertEqual(captured.exception.code, 404)
            captured.exception.close()

    def test_npm_version_probe_retains_default_output_and_diagnostics(self):
        node = shutil.which("node.exe" if os.name == "nt" else "node")
        self.assertIsNotNone(
            node, "The owning CI lane requires its prepared Node tool."
        )
        node_path = Path(node).resolve()
        candidates = [
            node_path.parent / "node_modules/npm/bin/npm-cli.js",
            node_path.parent.parent / "lib/node_modules/npm/bin/npm-cli.js",
        ]
        npm = next((candidate for candidate in candidates if candidate.is_file()), None)
        self.assertIsNotNone(npm, "The actual Node distribution must contain npm.")
        expected = json.loads(npm.parent.parent.joinpath("package.json").read_text())[
            "version"
        ]
        with mock.patch.dict(
            os.environ,
            {
                "SystemRoot": os.environ.get("SystemRoot", str(self.root)),
                "npm_config_timing": "true",
            },
            clear=True,
        ):
            environment = builder.clean_environment(
                self.root / "runtime", self.root, []
            )
        self.assertFalse(any(key.lower() == "npm_config_timing" for key in environment))
        before = subprocess.run(
            [str(node_path), str(npm), "--version"],
            env={**environment, "npm_config_timing": "true"},
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        after = subprocess.run(
            [str(node_path), str(npm), "--version"],
            env=environment,
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(before.returncode, 0)
        self.assertEqual(before.stdout.strip(), expected)
        self.assertIn("npm timing", before.stderr)
        self.assertEqual(after.returncode, 0)
        self.assertEqual(after.stdout.strip(), expected)
        self.assertEqual(after.stderr, "")
        # --version is an early-exit command; a read-only config command proves
        # normal default debug logging remains enabled without timing chatter.
        diagnostic = subprocess.run(
            [str(node_path), str(npm), "config", "get", "cache"],
            env=environment,
            cwd=self.root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(diagnostic.returncode, 0)
        self.assertEqual(diagnostic.stdout.strip(), environment["npm_config_cache"])
        self.assertEqual(diagnostic.stderr, "")
        self.assertTrue(
            list((self.root / "npm-cache/diagnostic-logs").glob("*-debug-*.log"))
        )

    def test_node_stage_keeps_real_failed_child_logs_outside_excluded_cache(self):
        with mock.patch.dict(
            os.environ,
            {"SystemRoot": os.environ.get("SystemRoot", str(self.root))},
            clear=True,
        ):
            environment = builder.clean_environment(
                self.root / "runtime", self.root, []
            )
        self.assertEqual(environment["NODE_DEPS_TIMEOUT"], "600")
        self.assertEqual(
            environment["npm_config_logs_dir"],
            str(self.root / "npm-cache/diagnostic-logs"),
        )
        self.assertNotEqual(
            environment["npm_config_userconfig"], environment["npm_config_globalconfig"]
        )
        child = (
            "import os,pathlib,sys; "
            "pathlib.Path(os.environ['TEMP'],'hermes-npm-browser-17.log').write_text('actual npm phase failure'); "
            "pathlib.Path(os.environ['npm_config_logs_dir'],'timing.json').write_text('{\"phase\":\"actual-child\"}'); "
            "sys.exit(7)"
        )
        with self.assertRaisesRegex(RuntimeError, "exited 7"):
            builder.run_owned(
                sys.executable,
                ["-c", child],
                environment,
                self.root,
                self.root,
                "stage-node-deps",
                timeout=3,
            )
        receipt = json.loads((self.root / "stage-node-deps.process.json").read_text())
        self.assertEqual(receipt["exitCode"], 7)
        self.assertFalse(receipt["passed"])
        retained = [
            item
            for item in receipt["retainedNodeLogs"]["files"]
            if item["category"] == "upstream-command-logs"
        ]
        self.assertEqual(len(retained), 1)
        self.assertFalse(retained[0]["truncated"])
        self.assertEqual(
            (self.root / "upstream-command-logs" / retained[0]["file"]).read_text(),
            "actual npm phase failure",
        )
        self.assertEqual(
            json.loads((self.root / "npm-logs/timing.json").read_text()),
            {"phase": "actual-child"},
        )
        self.assertEqual(
            receipt["upstreamNodeCommands"]["perCommandTimeoutSeconds"], 600
        )
        self.assertEqual(builder.official_stage_timeout("node-deps"), 1860)
        self.assertEqual(builder.official_stage_timeout("node"), 600)

    def test_node_log_retention_failure_preserves_real_primary_exit(self):
        with mock.patch.object(
            builder, "retain_node_stage_logs", side_effect=OSError("owned-log-denied")
        ):
            with self.assertRaisesRegex(RuntimeError, "exited 7") as captured:
                builder.run_owned(
                    sys.executable,
                    ["-c", "import sys;sys.exit(7)"],
                    os.environ.copy(),
                    self.root,
                    self.root,
                    "stage-node-deps",
                    timeout=3,
                )
        self.assertIn("owned-log-denied", " ".join(captured.exception.__notes__))
        receipt = json.loads((self.root / "stage-node-deps.process.json").read_text())
        self.assertEqual(receipt["exitCode"], 7)
        self.assertIsNone(receipt["retainedNodeLogs"])

    def test_node_log_retention_bounds_bytes_and_rejects_hardlinks(self):
        scratch = self.root / "npm-cache/tmp"
        scratch.mkdir(parents=True)
        source = scratch / "hermes-npm-browser-9.log"
        with source.open("wb") as handle:
            handle.seek(8 * 1024 * 1024)
            handle.write(b"x")
        retained = builder.retain_node_stage_logs(self.root)
        self.assertEqual(retained["files"][0]["retainedBytes"], 8 * 1024 * 1024)
        self.assertTrue(retained["files"][0]["truncated"])
        source.unlink()
        outside = self.root / "outside.txt"
        outside.write_text("must not be retained")
        os.link(outside, scratch / "hermes-npm-tui-10.log")
        with self.assertRaisesRegex(ValueError, "ordinary owned file"):
            builder.retain_node_stage_logs(self.root)
        self.assertFalse(
            (self.root / "upstream-command-logs/hermes-npm-tui-10.log").exists()
        )

    def build_receipts(self):
        runtime = self.root / "moved-runtime"
        runtime.mkdir()
        build = {
            "schemaVersion": 1,
            "upstreamCommit": freezer.UPSTREAM_COMMIT,
            "status": "runtime-provisioned",
            "installedTier": "hash-verified (uv.lock)",
            "fallbacks": [],
            "sourceUnchanged": True,
            "stages": [
                {"stage": name, "ok": True, "skipped": False}
                for name in freezer.REQUIRED_STAGES
            ],
        }
        build["nodeBuild"] = {
            "schemaVersion": 1,
            "profile": "official-prebuilt-cli-web-tui",
            "npmVersion": "12.0.2",
            "upstreamLockUnchanged": True,
            "neighboringBuildDependenciesAbsent": True,
            "tuiNonTtyImports": True,
            "desktopSelected": False,
            "outputs": [{"path": "ui-tui/dist"}, {"path": "hermes_cli/web_dist"}],
            "sidecars": [
                {"path": "plugins/platforms/photon/sidecar"},
                {"path": "scripts/whatsapp-bridge"},
            ],
        }
        build["selectedBrowserChain"] = {
            "profile": "official-prebuilt-cli-web-tui",
            "browserUse": "0.13.10",
            "agentBrowser": "agent-browser/bin/agent-browser-win32-x64.exe",
            "runtimeQualified": False,
        }
        relocation = {
            "schemaVersion": 1,
            "upstreamCommit": freezer.UPSTREAM_COMMIT,
            "status": "pass",
            "targetRoot": str(runtime),
            "sourceRoot": str(self.root / "unavailable-original"),
            "originalRootUnavailable": True,
            "containedInMxc": True,
            "cleanupPassed": True,
            "checks": [
                {"name": name, "passed": True} for name in freezer.REQUIRED_CHECKS
            ],
        }
        return runtime, build, relocation

    def test_freeze_gate_requires_complete_stage_set(self):
        runtime, build, relocation = self.build_receipts()
        build["stages"] = []
        with self.assertRaisesRegex(ValueError, "stage set"):
            freezer.validate_receipts(runtime, build, relocation)

    def test_freeze_gate_rejects_reachable_original_root(self):
        runtime, build, relocation = self.build_receipts()
        Path(relocation["sourceRoot"]).mkdir()
        with self.assertRaisesRegex(ValueError, "original runtime is still reachable"):
            freezer.validate_receipts(runtime, build, relocation)

    def test_freeze_gate_rejects_dependency_fallback(self):
        runtime, build, relocation = self.build_receipts()
        build["installedTier"] = "core only (no extras)"
        with self.assertRaisesRegex(ValueError, "locked provisioning"):
            freezer.validate_receipts(runtime, build, relocation)

    def test_freeze_gate_rejects_failed_conpty(self):
        runtime, build, relocation = self.build_receipts()
        next(check for check in relocation["checks"] if check["name"] == "conpty")[
            "passed"
        ] = False
        with self.assertRaisesRegex(ValueError, "capability failed"):
            freezer.validate_receipts(runtime, build, relocation)

    def test_inventory_records_all_bytes_without_pruning_debug_candidates(self):
        (self.root / "LICENSE").write_text("License text")
        (self.root / "runtime.d.ts").write_text("export type Item = string")
        (self.root / "runtime.js.map").write_text('{"sources":[]}')
        (self.root / "runtime.pdb").write_bytes(b"native symbols")
        value = freezer.inventory(self.root)
        self.assertEqual(
            {item["path"] for item in value["files"]},
            {"LICENSE", "runtime.d.ts", "runtime.js.map", "runtime.pdb"},
        )
        self.assertEqual(value["licenseFiles"], ["LICENSE"])
        self.assertEqual(
            {item["path"] for item in value["diagnosticsCandidates"]},
            {"runtime.d.ts", "runtime.js.map", "runtime.pdb"},
        )
        self.assertFalse(value["diagnosticsRemovalValidated"])


node_builder = load("official_node_builder", "build-official-node.py")
adapter = load("official_native_adapter", "nemoclaw_native_windows.py")


class SelectedNodeControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hermes-production-node-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def outputs(self):
        build, source = self.root / "build", self.root / "runtime"
        for relative in (
            "ui-tui/dist/entry.js",
            "hermes_cli/web_dist/index.html",
            "hermes_cli/web_dist/assets/data.bin",
        ):
            file = build / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"exact-official-output")
        return build, source

    def test_complete_output_copy_preserves_dynamic_resource_bytes(self):
        build, source = self.outputs()
        rows = node_builder.copy_output(build, source, "hermes_cli/web_dist")
        self.assertEqual(len(rows["files"]), 2)
        self.assertEqual(
            node_builder.regular_inventory(build / rows["path"]),
            node_builder.regular_inventory(source / rows["path"]),
        )

    def test_existing_output_is_not_overwritten(self):
        build, source = self.outputs()
        node_builder.copy_output(build, source, "ui-tui/dist")
        with self.assertRaisesRegex(ValueError, "not fresh"):
            node_builder.copy_output(build, source, "ui-tui/dist")

    def test_empty_output_is_refused(self):
        empty = self.root / "empty"
        empty.mkdir()
        with self.assertRaisesRegex(ValueError, "empty"):
            node_builder.regular_inventory(empty)

    @unittest.skipIf(
        os.name == "nt", "Windows link creation requires separate authority"
    )
    def test_output_cannot_follow_source_link(self):
        build, source = self.outputs()
        (build / "ui-tui/dist/leak").symlink_to(self.root / "outside")
        with self.assertRaisesRegex(ValueError, "link"):
            node_builder.copy_output(build, source, "ui-tui/dist")
        self.assertFalse(source.exists())

    def receipt(self):
        return {
            "schemaVersion": 1,
            "upstreamCommit": freezer.UPSTREAM_COMMIT,
            "status": "runtime-provisioned",
            "installedTier": "hash-verified (uv.lock)",
            "fallbacks": [],
            "sourceUnchanged": True,
            "stages": [
                {"stage": name, "ok": True, "skipped": False}
                for name in freezer.REQUIRED_STAGES
            ],
            "nodeBuild": {
                "schemaVersion": 1,
                "profile": "official-prebuilt-cli-web-tui",
                "npmVersion": "12.0.2",
                "upstreamLockUnchanged": True,
                "neighboringBuildDependenciesAbsent": True,
                "tuiNonTtyImports": True,
                "desktopSelected": False,
                "outputs": [{"path": value} for value in node_builder.OUTPUTS],
                "sidecars": [{"path": value} for value in node_builder.SIDECARS],
            },
            "selectedBrowserChain": {
                "profile": "official-prebuilt-cli-web-tui",
                "browserUse": "0.13.10",
                "agentBrowser": "agent-browser/bin/agent-browser-win32-x64.exe",
                "runtimeQualified": False,
            },
        }

    def test_selected_receipt_accepts_build_without_claiming_browser_execution(self):
        value = self.receipt()
        freezer.validate_build_receipt(value)
        self.assertFalse(value["selectedBrowserChain"]["runtimeQualified"])
        self.assertNotIn("node-deps", {stage["stage"] for stage in value["stages"]})

    def test_missing_or_changed_selected_capability_refuses_export(self):
        changes = {
            "profile": "desktop",
            "npmVersion": "10.9.8",
            "upstreamLockUnchanged": False,
            "neighboringBuildDependenciesAbsent": False,
            "tuiNonTtyImports": False,
            "desktopSelected": True,
            "outputs": [{"path": "ui-tui/dist"}],
            "sidecars": [],
        }
        for field, replacement in changes.items():
            with self.subTest(field=field):
                value = self.receipt()
                value["nodeBuild"][field] = replacement
                with self.assertRaisesRegex(ValueError, "production Node closure"):
                    freezer.validate_build_receipt(value)

    def test_missing_or_qualified_browser_chain_refuses_build_only_export(self):
        for field, replacement in {
            "browserUse": "latest",
            "agentBrowser": "host/agent-browser.exe",
            "runtimeQualified": True,
        }.items():
            with self.subTest(field=field):
                value = self.receipt()
                value["selectedBrowserChain"][field] = replacement
                with self.assertRaisesRegex(ValueError, "browser chain"):
                    freezer.validate_build_receipt(value)

    def contract(self):
        record = {
            "schemaVersion": 1,
            "upstreamCommit": adapter.REVISION,
            "profile": "official-prebuilt-cli-web-tui",
            "tui": "hermes-agent/ui-tui/dist/entry.js",
            "web": "hermes-agent/hermes_cli/web_dist/index.html",
            "chromium": "browsers/chromium-1228/chrome-win64/chrome.exe",
            "agentBrowser": "agent-browser/bin/agent-browser-win32-x64.exe",
            "browserUse": "0.13.10",
        }
        for key in ("tui", "web", "chromium", "agentBrowser"):
            file = self.root / record[key]
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"owned-component")
        (self.root / "nemoclaw-hermes-node.json").write_text(json.dumps(record))
        return record

    def test_exact_prebuilt_env_uses_installed_paths(self):
        self.contract()
        with mock.patch.dict(os.environ, {}, clear=True):
            adapter._install_prebuilt_node(self.root)
            self.assertEqual(
                os.environ["HERMES_TUI_DIR"], str(self.root / "hermes-agent/ui-tui")
            )
            self.assertEqual(
                os.environ["HERMES_WEB_DIST"],
                str(self.root / "hermes-agent/hermes_cli/web_dist"),
            )
            self.assertEqual(
                os.environ["AGENT_BROWSER_EXECUTABLE_PATH"],
                str(self.root / "browsers/chromium-1228/chrome-win64/chrome.exe"),
            )

    def test_component_only_probe_does_not_invent_a_production_route(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            adapter._install_prebuilt_node(self.root)
            self.assertNotIn("HERMES_TUI_DIR", os.environ)

    def test_missing_prebuilt_file_does_not_trigger_source_fallback(self):
        record = self.contract()
        (self.root / record["tui"]).unlink()
        with self.assertRaises(adapter.NativeStartupRefusal):
            adapter._install_prebuilt_node(self.root)

    def test_external_browser_or_worktree_paths_are_rejected(self):
        record = self.contract()
        for field, replacement in {
            "chromium": "../host/chrome.exe",
            "tui": "other/dist/entry.js",
            "agentBrowser": "C:/host/browser.exe",
        }.items():
            with self.subTest(field=field):
                bad = copy.deepcopy(record)
                bad[field] = replacement
                (self.root / "nemoclaw-hermes-node.json").write_text(json.dumps(bad))
                with self.assertRaises(adapter.NativeStartupRefusal):
                    adapter._prebuilt_node(self.root)

    def test_browser_resolver_keeps_owned_candidate_and_disables_npx_fallback(self):
        record = self.contract()
        module = types.ModuleType("tools.browser_tool_install")
        observed = []
        module.agent_browser_runnable = lambda value: observed.append(value) or True
        module._find_agent_browser = lambda **_kwargs: self.fail(
            "ambient resolver was called"
        )
        adapter._adapt_module(module, self.root, self.root / "git/bin/bash.exe")
        self.assertIsNone(module._resolve_npx_bin())
        self.assertEqual(
            module._find_agent_browser(), str(self.root / record["agentBrowser"])
        )
        self.assertEqual(
            module._find_agent_browser(validate=False),
            str(self.root / record["agentBrowser"]),
        )
        self.assertEqual(
            module._find_agent_browser(), str(self.root / record["agentBrowser"])
        )
        self.assertEqual(observed, [str(self.root / record["agentBrowser"])])

    def test_unrunnable_browser_never_enters_install_or_host_fallback(self):
        self.contract()
        module = types.ModuleType("tools.browser_tool_install")
        module.agent_browser_runnable = lambda _value: False
        module._find_agent_browser = lambda **_kwargs: self.fail(
            "installer fallback was called"
        )
        adapter._adapt_module(module, self.root, self.root / "git/bin/bash.exe")
        with self.assertRaisesRegex(FileNotFoundError, "Repair NemoClaw"):
            module._find_agent_browser()


if __name__ == "__main__":
    unittest.main()
