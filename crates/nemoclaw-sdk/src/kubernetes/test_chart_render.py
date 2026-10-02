# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Opt-in offline render of the exact upstream chart with real deployment values.

Set NEMOCLAW_TEST_OPENSHELL_CHART to the chart in the pinned source checkout.
Requires Helm and PyYAML; never contacts a cluster or fetches an artifact.
"""

import json
import os
import subprocess
import sys
import tomllib
import unittest
from pathlib import Path
from unittest.mock import PropertyMock, patch

import test_platform

ROOT = Path(__file__).resolve().parents[4]


@unittest.skipUnless(os.environ.get("NEMOCLAW_TEST_OPENSHELL_CHART"), "set the pinned chart path")
class ChartRenderTests(unittest.TestCase):
    setUp = test_platform.PlatformTests.setUp

    def render(self, values):
        import yaml

        chart = Path(os.environ["NEMOCLAW_TEST_OPENSHELL_CHART"]).resolve()
        pins = json.loads((ROOT / "versions.json").read_text())
        revision = subprocess.check_output(
            ["git", "-C", str(chart), "rev-parse", "HEAD"], text=True
        ).strip()
        self.assertEqual(revision, pins["openshellRevision"])
        rendered = subprocess.check_output(
            [
                "helm",
                "template",
                "test",
                str(chart),
                "--namespace",
                "owned-namespace",
                "--skip-tests",
                "--set",
                "agentSandbox.preflight.enabled=false",
                "-f",
                "-",
            ],
            input=json.dumps(values),
            text=True,
            timeout=30,
        )
        objects = [obj for obj in yaml.safe_load_all(rendered) if obj]
        self.assertFalse(
            any(
                obj["kind"] in ("Route", "Ingress", "SecurityContextConstraints") for obj in objects
            )
        )
        gateway = next(obj for obj in objects if obj["kind"] == "StatefulSet")
        pod = gateway["spec"]["template"]["spec"]
        self.assertEqual(pod["containers"][0]["image"], pins["images"]["gateway"])
        jobs = [obj for obj in objects if obj["kind"] == "Job"]
        self.assertTrue(jobs)
        for job in jobs:
            job_pod = job["spec"]["template"]["spec"]
            self.assertNotIn("runAsUser", job_pod.get("securityContext", {}))
            for container in job_pod["containers"]:
                self.assertEqual(container["image"], pins["images"]["gateway"])
                self.assertNotIn("runAsUser", container["securityContext"])
                self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
                self.assertEqual(container["securityContext"]["capabilities"], {"drop": ["ALL"]})
        config = next(
            obj["data"]["gateway.toml"]
            for obj in objects
            if obj["kind"] == "ConfigMap" and "gateway.toml" in obj.get("data", {})
        )
        config = tomllib.loads(config)["openshell"]
        driver = config["drivers"]["kubernetes"]
        for field, image in (
            ("sandbox_runtime_image", "sandboxRuntime"),
            ("default_image", "sandboxRuntime"),
            ("supervisor_image", "supervisor"),
        ):
            self.assertEqual(driver[field], pins["images"][image])
        self.assertFalse(config["gateway"].get("disable_tls", False))
        self.assertFalse(
            config["gateway"].get("auth", {}).get("allow_unauthenticated_users", False)
        )
        self.assertIn("client_ca_path", config["gateway"]["tls"])
        return pod

    def test_managed_openshift_render_keeps_pins_tls_and_namespace_identity(self):
        selected = test_platform.spec()
        selected["settings"]["kubernetes"]["distribution"] = "openshift"
        client = test_platform.platform.Platform(
            {"action": "read", "spec": selected, "stateDirectory": str(self.state)}
        )
        client.receipt = {"openshiftIdentity": {"uid": 1000700000, "gid": 1000800000}}
        pins = {"versions": json.loads((ROOT / "versions.json").read_text())}
        with patch.object(type(client), "pins", new_callable=PropertyMock, return_value=pins):
            pod = self.render(client.values())
        self.assertEqual(pod["securityContext"]["fsGroup"], 1000800000)
        self.assertEqual(pod["securityContext"]["seccompProfile"], {"type": "RuntimeDefault"})
        context = pod["containers"][0]["securityContext"]
        self.assertEqual(context["runAsUser"], 1000700000)
        self.assertEqual(context["runAsGroup"], 1000800000)
        self.assertTrue(context["runAsNonRoot"])
        self.assertFalse(context["allowPrivilegeEscalation"])
        self.assertEqual(context["capabilities"], {"drop": ["ALL"]})

    def test_standalone_fixture_render_keeps_pins_and_tls(self):
        values = subprocess.check_output(
            [
                sys.executable,
                "-B",
                "-c",
                "import json,stack; print(json.dumps(stack.chart_values()))",
            ],
            cwd=ROOT / "tools/kubernetes",
            text=True,
            timeout=30,
        )
        self.render(json.loads(values))
