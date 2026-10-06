# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Verify assembled agent images using only their installed runtime."""

import hashlib
import importlib.metadata
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest
from pathlib import Path


def satisfies(version, specifier):
    """Check a version against the comparison clauses Fabric's adapters use.

    The image has no pip, so this replaces its vendored packaging module. It
    rejects any clause it does not understand rather than accept it.
    """

    def parse(text):
        return tuple(int(part) for part in text.split("."))

    current = parse(version)
    checks = {
        ">=": lambda bound: current >= bound,
        "<": lambda bound: current < bound,
        "==": lambda bound: current[: len(bound)] == bound,
    }
    for clause in specifier.split(","):
        clause = clause.strip()
        operator = next((op for op in (">=", "==", "<") if clause.startswith(op)), None)
        if operator is None or not clause[len(operator) :].strip().replace(".", "").isdigit():
            raise ValueError(f"unsupported requires-python clause: {clause!r}")
        if not checks[operator](parse(clause[len(operator) :].strip())):
            return False
    return True


class AgentImage(unittest.TestCase):
    def test_bridge_entrypoint_reports_argument_errors_as_one_json_response(self):
        command = json.loads(os.environ["NEMOCLAW_TEST_CATALOG"])["runtime"]["command"]
        self.assertEqual(command, ["/usr/local/bin/fabric-agent"])
        self.assertTrue(Path(command[0]).is_file())
        self.assertTrue(os.access(command[0], os.X_OK))
        result = subprocess.run(
            [*command, "check", "--agent", "image-contract", "--unknown"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stdout.endswith("\n"))
        response = json.loads(result.stdout)
        self.assertEqual(set(response), {"operation", "status", "changed", "result", "error"})
        self.assertEqual(response["operation"], "check")
        self.assertEqual(response["status"], "failed")
        self.assertEqual(response["error"]["effects"], "none")

    def test_shared_python_satisfies_every_pinned_fabric_adapter(self):

        # Every harness uses the same base, including adapters not in this image.
        with tarfile.open("/opt/nemoclaw/source/fabric.tar.gz") as source:
            projects = [
                item
                for item in source
                if item.name.count("/") == 4
                and "/adapters/python/" in item.name
                and item.name.endswith("/pyproject.toml")
            ]
            self.assertTrue(projects, "retained Fabric source contains no Python adapters")
            for item in projects:
                project = tomllib.loads(source.extractfile(item).read().decode())["project"]
                with self.subTest(adapter=project["name"]):
                    self.assertTrue(
                        satisfies(platform.python_version(), project["requires-python"]),
                        project["requires-python"],
                    )

    def test_fabric_environment_carries_no_package_installer(self):
        # Images install everything at build time; an installer only adds size.
        prefix = Path(sys.prefix)
        self.assertIsNone(importlib.util.find_spec("pip"))
        self.assertEqual(sorted(path.name for path in (prefix / "bin").glob("pip*")), [])

    def test_only_javascript_harnesses_carry_node(self):
        # OpenClaw's CLI, Hermes's TUI, and the TypeScript Pi adapter run on Node.js.
        expected = os.environ["NEMOCLAW_TEST_HARNESS"] in {"openclaw", "hermes", "pi"}
        self.assertEqual(shutil.which("node") is not None, expected)
        self.assertEqual(Path("/usr/local/lib/node_modules").exists(), expected)

    def test_catalog_carries_installed_runtime_directories(self):
        catalog = json.loads(os.environ["NEMOCLAW_TEST_CATALOG"])
        declaration = Path("/opt/nemoclaw/runtime-files.json")
        expected = json.loads(declaration.read_text()) if declaration.exists() else {}
        self.assertEqual(catalog.get("runtime_files", {}), expected)
        for adapter, paths in expected.items():
            for path in paths:
                with self.subTest(adapter=adapter, path=path):
                    self.assertTrue(Path(path).is_dir(), path)
                    self.assertTrue(os.access(path, os.R_OK | os.X_OK), path)

    def test_label_matches_discovery_from_installed_fabric(self):
        from catalog import snapshot

        provenance = json.loads(Path("/opt/nemoclaw/provenance.json").read_text())
        actual = snapshot(
            provenance["fabric_revision"], provenance["source_sha256"], installed_only=True
        )
        self.assertTrue(actual["adapters"], "image installs no discoverable Fabric adapter")
        self.assertEqual(json.loads(os.environ["NEMOCLAW_TEST_CATALOG"]), actual)

    @unittest.skipIf(
        os.environ.get("NEMOCLAW_TEST_HARNESS") == "hermes", "Hermes native supplement"
    )
    def test_installed_dependencies_follow_the_fabric_lock(self):
        with tarfile.open("/opt/nemoclaw/source/fabric.tar.gz") as source:
            lock = next(
                item
                for item in source
                if item.name.count("/") == 1 and item.name.endswith("/uv.lock")
            )
            packages = tomllib.loads(source.extractfile(lock).read().decode())["package"]
        for package in packages:
            if "registry" not in package["source"]:
                continue
            try:
                installed = importlib.metadata.version(package["name"])
            except importlib.metadata.PackageNotFoundError:
                continue
            versions = {item["version"] for item in packages if item["name"] == package["name"]}
            self.assertIn(installed, versions, package["name"])

    @unittest.skipUnless(os.environ.get("NEMOCLAW_TEST_HARNESS") == "pi", "Pi image only")
    def test_pi_installs_packed_adapters_without_source_tests(self):
        root = Path("/opt/fabric-source")
        for package in (
            "adapter-contract/typescript",
            "adapters/typescript/common",
            "adapters/typescript/pi",
        ):
            directory = root / package
            manifest = json.loads((directory / "package.json").read_text())
            self.assertEqual(
                {path.name for path in directory.iterdir()},
                set(manifest["files"]) | {"package.json"},
                package,
            )
        self.assertFalse((root / "adapters/typescript/opencode").exists())

    @unittest.skipUnless(os.environ.get("NEMOCLAW_TEST_HARNESS") == "hermes", "Hermes image only")
    def test_hermes_accepts_fabric_request_metadata(self):
        from gateway.platforms.api_server import _request_relay_metadata

        metadata = {"request_id": "image-qualification", "context": {"tenant": "owned"}}
        extracted = _request_relay_metadata({"metadata": metadata})
        self.assertEqual(extracted, metadata)
        self.assertIsNot(extracted, metadata)
        self.assertEqual(_request_relay_metadata({"metadata": "invalid"}), {})

    @unittest.skipUnless(
        os.environ.get("NEMOCLAW_TEST_HARNESS") == "openclaw", "OpenClaw image only"
    )
    def test_openclaw_loads_search_plugins_without_explicit_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "openclaw.json"
            config.write_text(
                json.dumps(
                    {
                        "plugins": {
                            "allow": ["brave", "tavily"],
                            "entries": {"brave": {"enabled": True}, "tavily": {"enabled": True}},
                        }
                    }
                )
            )
            output = subprocess.run(
                ["node", "/app/openclaw.mjs", "plugins", "list", "--json"],
                env={
                    **os.environ,
                    "OPENCLAW_STATE_DIR": directory,
                    "OPENCLAW_CONFIG_PATH": str(config),
                },
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
            )
            self.assertEqual(output.returncode, 0, output.stderr)
            plugins = {item["id"]: item for item in json.loads(output.stdout)["plugins"]}
            for worker in (
                "openclaw-database-verify.worker.js",
                "openclaw-state-lease-heartbeat.worker.js",
            ):
                self.assertTrue((Path("/app/dist/state") / worker).is_file(), worker)
            self.assertFalse(list(Path("/app/dist/state").glob("*.sqlite*")))
            self.assertFalse(Path("/app/dist/config-journal-fingerprint.key").exists())
            self.assertFalse(Path("/tmp/plugin-build").exists())
            for name in ("brave", "tavily"):
                self.assertIn(name, set(plugins))
                self.assertEqual(plugins[name]["origin"], "bundled")
                self.assertTrue(plugins[name]["enabled"], plugins[name])
                self.assertIsNone(plugins[name].get("error"), plugins[name])

    def test_runtime_retains_matching_sources_without_build_toolchains(self):
        root = Path("/opt/nemoclaw")
        manifest = json.loads((root / "provenance.json").read_text())
        self.assertEqual(manifest["harness"], os.environ["NEMOCLAW_TEST_HARNESS"])
        sources = root / "source"
        for name, expected in manifest["local_sources"].items():
            self.assertEqual(
                hashlib.sha256((sources / "local" / name).read_bytes()).hexdigest(), expected, name
            )
        self.assertEqual(
            hashlib.sha256((sources / "fabric.tar.gz").read_bytes()).hexdigest(),
            manifest["source_sha256"],
        )
        self.assertEqual(
            hashlib.sha256((sources / "requirements.txt").read_bytes()).hexdigest(),
            manifest["requirements_sha256"],
        )
        for path in root.glob("*.py"):
            self.assertEqual(path.read_bytes(), (sources / "local" / path.name).read_bytes())
        # OpenShell's Kubernetes driver runs sandboxes as 10001:10001, and
        # Docker and Podman use the image's own user, so one ID fits all three.
        self.assertEqual((os.getuid(), os.getgid()), (10001, 10001))
        self.assertEqual(Path("/sandbox").stat().st_uid, 10001)
        # OpenShell seeds a Kubernetes workspace by copying the image's
        # /sandbox, and its supervisor makes probe directories under TMPDIR
        # before Fabric starts; the seed must already hold that directory.
        runtime = json.loads(Path("/opt/nemoclaw/runtime.json").read_text())
        temporary = Path(runtime["environment"]["TMPDIR"])
        self.assertTrue(temporary.is_relative_to("/sandbox"), temporary)
        self.assertTrue(temporary.is_dir(), temporary)
        self.assertEqual(temporary.stat().st_uid, 10001)
        for tool in ("rustc", "cargo", "uv", "gcc"):
            self.assertIsNone(shutil.which(tool), tool)


if __name__ == "__main__":
    unittest.main()
