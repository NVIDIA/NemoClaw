# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import base64
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


MODULE = Path(__file__).with_name("materialize-openclaw-build.py")
SPEC = importlib.util.spec_from_file_location("openclaw_materializer", MODULE)
materializer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(materializer)


def package(version, name="dependency"):
    return {
        "version": version,
        "resolved": f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz",
        "integrity": "sha512-test-fixture",
    }


class RuntimeDependencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="openclaw-dependency-plan-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.lock_file = self.root / "build.lock.json"
        self.dependency_file = self.root / "runtime.lock.json"
        self.core = package("2026.9.2", "openclaw")
        self.document = {
            "name": "nemoclaw-openclaw-runtime",
            "lockfileVersion": 3,
            "packages": {
                "": {"dependencies": {"openclaw": "2026.9.2"}},
                "node_modules/openclaw": self.core,
                "node_modules/dependency": package("2.0.0"),
                "node_modules/openclaw/node_modules/dependency": package("1.0.0"),
                "node_modules/consumer": package("1.0.0", "consumer"),
                "node_modules/consumer/node_modules/dependency": package("1.0.0"),
            },
        }
        self.lock = {
            "schemaVersion": 1,
            "openclaw": {
                "version": self.core["version"],
                "url": self.core["resolved"],
                "integrity": self.core["integrity"],
            },
            "dependencyLock": {"path": self.dependency_file.name},
            "compilerPackages": [],
        }
        self.save_lock()

    def save_lock(self):
        raw = json.dumps(self.document).encode()
        self.dependency_file.write_bytes(raw)
        self.lock["dependencyLock"]["sha256"] = hashlib.sha256(raw).hexdigest()
        self.lock_file.write_text(json.dumps(self.lock))

    def test_keeps_nested_versions_and_deduplicates_only_archive_downloads(self):
        raw, core, plan, requested = materializer.dependency_plan(self.lock, self.lock_file)
        self.assertEqual(raw, self.dependency_file.read_bytes())
        self.assertEqual(core, "node_modules/openclaw")
        self.assertEqual(len(plan), 5)
        self.assertEqual(len(requested), 4)
        locations = {name: (parts, item["version"]) for name, parts, item in plan}
        self.assertEqual(locations["node_modules/dependency"][1], "2.0.0")
        self.assertEqual(locations["node_modules/openclaw/node_modules/dependency"],
                         (("node_modules", "openclaw", "node_modules", "dependency"), "1.0.0"))
        self.assertEqual(locations["node_modules/consumer/node_modules/dependency"][1], "1.0.0")

    def test_rejects_changed_lock_bytes(self):
        self.dependency_file.write_bytes(self.dependency_file.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
            materializer.dependency_plan(self.lock, self.lock_file)

    def test_rejects_source_version_url_or_integrity_drift(self):
        for field, value in [("version", "2026.7.1"), ("url", "https://example.org/core.tgz"),
                             ("integrity", "sha512-changed")]:
            with self.subTest(field=field):
                lock = copy.deepcopy(self.lock)
                lock["openclaw"][field] = value
                with self.assertRaisesRegex(ValueError, "differs"):
                    materializer.dependency_plan(lock, self.lock_file)

    def test_rejects_nonpackage_and_windows_aliased_locations(self):
        for name in ["../escape", "node_modules/a/../../escape", "node_modules/CON",
                     "node_modules/a.", "node_modules/a/payload", "node_modules/@scope",
                     "node_modules/DEPENDENCY"]:
            with self.subTest(name=name):
                self.document["packages"][name] = package("3.0.0")
                self.save_lock()
                with self.assertRaises(ValueError):
                    materializer.dependency_plan(self.lock, self.lock_file)
                del self.document["packages"][name]

    def test_rejects_links_and_inconsistent_integrity_for_one_archive(self):
        item = self.document["packages"]["node_modules/consumer/node_modules/dependency"]
        item["link"] = True
        self.save_lock()
        with self.assertRaisesRegex(ValueError, "linked"):
            materializer.dependency_plan(self.lock, self.lock_file)
        del item["link"]
        item["integrity"] = "sha512-different"
        self.save_lock()
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            materializer.dependency_plan(self.lock, self.lock_file)

    def test_materializes_distinct_versions_and_records_the_original_lock(self):
        policy_parser = package("2.8.3", "yaml")
        self.lock["compilerPackages"] = [{
            "package": "yaml", "version": policy_parser["version"],
            "url": policy_parser["resolved"], "integrity": policy_parser["integrity"],
        }]
        self.save_lock()
        archives = {}
        inputs = [*self.document["packages"].items(), ("node_modules/yaml", policy_parser)]
        for name, item in inputs:
            if not name or item["resolved"] in archives:
                continue
            filename = self.root / f"archive-{len(archives)}.tgz"
            content = json.dumps({"name": name.split("/")[-1], "version": item["version"]}).encode()
            with tarfile.open(filename, "w:gz") as archive:
                member = tarfile.TarInfo("package/package.json")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            archives[item["resolved"]] = {"url": item["resolved"], "archive": str(filename)}
        output = self.root / "inputs"
        with patch.object(materializer, "fetch", side_effect=lambda item, *_: archives[item["url"]]), \
             patch("sys.argv", [str(MODULE), "--lock", str(self.lock_file), "--output", str(output),
                                "--cache", str(self.root / "cache"), "--portable-proof"]):
            materializer.main()
        for name, item in self.document["packages"].items():
            if name:
                metadata = json.loads((output / name / "package.json").read_text())
                self.assertEqual(metadata["version"], item["version"])
        self.assertEqual((output / "runtime-package-lock.json").read_bytes(), self.dependency_file.read_bytes())
        receipt = json.loads((output / "materialization-receipt.json").read_text())
        self.assertEqual(receipt["sourceRoot"], "node_modules/openclaw")
        self.assertEqual(receipt["dependencyLock"]["sha256"], self.lock["dependencyLock"]["sha256"])
        self.assertEqual(len(receipt["dependencies"]), 4)
        self.assertEqual(json.loads((output / "tools/node_modules/yaml/package.json").read_text()),
                         {"name": "yaml", "version": "2.8.3"})
        self.assertEqual([item["package"] for item in receipt["compiler"]], ["yaml"])
        self.assertFalse(receipt["lifecycleScriptsExecuted"])
        self.assertFalse(receipt["runtimeReady"])

    def test_checked_in_lock_matches_canonical_runtime(self):
        lock_file = MODULE.with_name("windows-app-build.lock.json")
        lock = json.loads(lock_file.read_text())
        _, core, plan, _ = materializer.dependency_plan(lock, lock_file)
        self.assertEqual(core, "node_modules/openclaw")
        paths = {name for name, _, _ in plan}
        self.assertIn("node_modules/openclaw/node_modules/typescript", paths)
        self.assertIn("node_modules/undici", paths)
        self.assertEqual(lock["openclaw"]["version"], "2026.9.2")

    def test_shared_tools_restore_policy_parser_without_agent_payloads(self):
        source = MODULE.parent.parent / "distribution/prepare-native-build-tools.py"
        spec = importlib.util.spec_from_file_location("shared_tools", source)
        shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(shared)
        lock = json.loads(source.with_name("native-build-tools.lock.json").read_text())
        cache = self.root / "shared-cache"
        cache.mkdir()
        for pin in lock["packages"]:
            archive_path = cache / (hashlib.sha256(pin["url"].encode()).hexdigest() + ".tgz")
            content = json.dumps({"name": pin["package"], "version": pin["version"]}).encode()
            with tarfile.open(archive_path, "w:gz") as archive:
                member = tarfile.TarInfo("package/package.json")
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            pin["integrity"] = "sha512-" + base64.b64encode(hashlib.sha512(archive_path.read_bytes()).digest()).decode()
        lock_file = self.root / "shared.lock.json"
        lock_file.write_text(json.dumps(lock))
        output = self.root / "shared-tools"
        with patch.object(shared, "os", SimpleNamespace(name="nt", environ={"GITHUB_ACTIONS": "true"})), \
             patch("urllib.request.urlopen", side_effect=AssertionError("Unexpected network request")):
            shared.prepare(output, cache, lock_file)
        parser = json.loads((output / "tools/node_modules/yaml/package.json").read_text())
        self.assertEqual(parser["name"], "yaml")
        receipt = json.loads((output / "materialization-receipt.json").read_text())
        self.assertIn("yaml", [pin["package"] for pin in receipt["packages"]])
        self.assertEqual(receipt["agentPayloads"], [])
        self.assertFalse(receipt["lifecycleScriptsExecuted"])
        self.assertFalse(receipt["installedAcceptance"])

    def test_choice_plan_retains_nested_voice_and_native_platform_packages(self):
        lock_file = MODULE.with_name("windows-app-build.lock.json")
        lock = json.loads(lock_file.read_text())
        _, _, core_plan, _ = materializer.dependency_plan(lock, lock_file)
        raw, plan = materializer.choice_dependency_plan(lock, lock_file, core_plan)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), lock["choiceDependencyLock"]["sha256"])
        locations = {location: item for location, _, item in plan}
        self.assertEqual(locations["plugins/discord/node_modules/@discordjs/voice/node_modules/@snazzah/davey"]["version"], "0.1.12")
        self.assertEqual(locations["plugins/discord/node_modules/@snazzah/davey-win32-arm64-msvc"]["version"], "0.1.12")
        self.assertIn("node_modules/@emnapi/core", locations)
        self.assertFalse(any("googlechat" in location or "msteams" in location for location in locations))

    def test_choice_plan_rejects_hash_and_shared_version_drift(self):
        lock_file = MODULE.with_name("windows-app-build.lock.json")
        lock = json.loads(lock_file.read_text())
        _, _, core_plan, _ = materializer.dependency_plan(lock, lock_file)
        changed = copy.deepcopy(lock)
        changed["choiceDependencyLock"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Choice dependency lock SHA256"):
            materializer.choice_dependency_plan(changed, lock_file, core_plan)
        changed_plan = copy.deepcopy(core_plan)
        next(item for location, _, item in changed_plan if location == "node_modules/tslib")["version"] = "0.0.0"
        with self.assertRaisesRegex(ValueError, "Conflicting shared"):
            materializer.choice_dependency_plan(lock, lock_file, changed_plan)

    def test_restores_missing_choice_package_but_rejects_existing_identity_drift(self):
        archive_file = self.root / "native.tgz"
        content = json.dumps({"name": "native", "version": "1.0.0"}).encode()
        with tarfile.open(archive_file, "w:gz") as archive:
            member = tarfile.TarInfo("package/package.json")
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
        dependency = package("1.0.0", "native")
        plan = [("plugins/discord/node_modules/native", "native", dependency)]
        output = self.root / "choice-inputs"
        with patch.object(materializer, "fetch", return_value={"archive": str(archive_file)}) as fetch:
            restored = materializer.restore_choice_dependencies(plan, output, self.root / "cache", 0)
            self.assertEqual(len(restored), 1)
            fetch.assert_called_once()
            fetch.reset_mock()
            materializer.restore_choice_dependencies(plan, output, self.root / "cache", 0)
            fetch.assert_not_called()
            dependency["version"] = "2.0.0"
            with self.assertRaisesRegex(ValueError, "identity differs"):
                materializer.restore_choice_dependencies(plan, output, self.root / "cache", 0)
            fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
