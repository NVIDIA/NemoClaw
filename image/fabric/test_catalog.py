# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import io
import json
import tarfile
import unittest

from catalog import collect


class CatalogTests(unittest.TestCase):
    def test_new_upstream_adapter_is_discovered_without_a_harness_list(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as output:
            for name in [
                "adapters/python/new-agent/new-agent.fabric-adapter.json",
                "tests/fake.fabric-adapter.json",
            ]:
                raw = json.dumps(
                    {
                        "contract_version": "fabric.adapter/v1alpha2",
                        "adapter_id": name,
                        "adapter_kind": "python",
                    }
                ).encode()
                member = tarfile.TarInfo("fabric/" + name)
                member.size = len(raw)
                output.addfile(member, io.BytesIO(raw))
        adapters = collect(archive.getvalue())
        self.assertEqual([item["harness"] for item in adapters], ["new-agent"])
        self.assertEqual(adapters[0]["descriptor"]["adapter_id"], adapters[0]["adapter_id"])

    def test_invalid_descriptor_is_rejected(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as output:
            raw = b"{}"
            member = tarfile.TarInfo("fabric/adapters/python/bad/bad.fabric-adapter.json")
            member.size = len(raw)
            output.addfile(member, io.BytesIO(raw))
        with self.assertRaises(ValueError):
            collect(archive.getvalue())


class ImageCatalogTests(unittest.TestCase):
    def test_hermes_advertises_local_and_patched_packaged_adapter(self):
        from catalog import image_adapters

        upstream = {
            "harness": "hermes",
            "source": "adapters/python/hermes/hermes.fabric-adapter.json",
            "adapter_id": "nvidia.fabric.hermes",
            "descriptor": {"settings_schema": {"properties": {}}},
        }
        local = {
            "harness": "hermes",
            "source": "image/fabric/hermes.fabric-adapter.json",
            "adapter_id": "nemoclaw.local.hermes",
            "descriptor": {"settings_schema": {"properties": {"api_mode": {"enum": ["local"]}}}},
        }
        result = image_adapters([upstream, local], "hermes", "hermes")
        self.assertEqual(len(result), 2)
        self.assertEqual(
            result[0]["descriptor"]["settings_schema"]["properties"]["api_mode"]["enum"],
            ["chat_completions", "codex_responses", "anthropic_messages"],
        )
        self.assertEqual(result[1], local)
        self.assertNotIn("api_mode", upstream["descriptor"]["settings_schema"]["properties"])

    def test_nooa_image_advertises_both_descriptors_from_its_package(self):
        from catalog import image_adapters

        records = [
            {
                "harness": name,
                "source": f"adapters/python/nooa/{name}.fabric-adapter.json",
                "descriptor": {},
            }
            for name in ["nooa", "nooa-bench"]
        ]
        self.assertEqual(image_adapters(records, "nooa", "nooa"), records)
