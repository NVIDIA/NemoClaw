// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const policies = require("../bin/lib/policies");

describe("policies", () => {
  describe("listPresets", () => {
    const expected = ["apt", "cargo", "discord", "docker", "ghcr", "go", "huggingface", "jira", "npm", "outlook", "pypi", "slack", "telegram"];

    it("returns all presets", () => {
      const presets = policies.listPresets();
      assert.equal(presets.length, expected.length);
    });

    it("each preset has name and description", () => {
      for (const p of policies.listPresets()) {
        assert.ok(p.name, `preset missing name: ${p.file}`);
        assert.ok(p.description, `preset missing description: ${p.file}`);
      }
    });

    it("returns expected preset names", () => {
      const names = policies.listPresets().map((p) => p.name).sort();
      assert.deepEqual(names, expected);
    });
  });

  describe("loadPreset", () => {
    it("loads existing preset", () => {
      const content = policies.loadPreset("outlook");
      assert.ok(content);
      assert.ok(content.includes("network_policies:"));
    });

    it("returns null for nonexistent preset", () => {
      assert.equal(policies.loadPreset("nonexistent"), null);
    });
  });

  describe("getPresetEndpoints", () => {
    it("extracts hosts from outlook preset", () => {
      const content = policies.loadPreset("outlook");
      const hosts = policies.getPresetEndpoints(content);
      assert.ok(hosts.includes("graph.microsoft.com"));
      assert.ok(hosts.includes("login.microsoftonline.com"));
      assert.ok(hosts.includes("outlook.office365.com"));
      assert.ok(hosts.includes("outlook.office.com"));
    });

    it("extracts hosts from telegram preset", () => {
      const content = policies.loadPreset("telegram");
      const hosts = policies.getPresetEndpoints(content);
      assert.deepEqual(hosts, ["api.telegram.org"]);
    });

    it("every preset has at least one endpoint", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        const hosts = policies.getPresetEndpoints(content);
        assert.ok(hosts.length > 0, `${p.name} has no endpoints`);
      }
    });
  });

  describe("buildPolicySetCommand", () => {
    it("quotes sandbox name to prevent argument splitting", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
      assert.equal(cmd, 'openshell policy set --policy "/tmp/policy.yaml" --wait "my-assistant"');
    });

    it("handles sandbox names with spaces", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my sandbox");
      assert.ok(cmd.includes('"my sandbox"'), "sandbox name must be quoted");
    });

    it("places --wait before the sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test-box");
      const waitIdx = cmd.indexOf("--wait");
      const nameIdx = cmd.indexOf('"test-box"');
      assert.ok(waitIdx < nameIdx, "--wait must come before sandbox name");
    });
  });

  describe("buildPolicyGetCommand", () => {
    it("quotes sandbox name", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      assert.equal(cmd, 'openshell policy get --full "my-assistant" 2>/dev/null');
    });
  });

  describe("preset YAML schema", () => {
    it("no preset has rules at NetworkPolicyRuleDef level", () => {
      // rules must be inside endpoints, not as sibling of endpoints/binaries
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // rules: at 4-space indent (same level as endpoints:) is wrong
          // rules: at 8+ space indent (inside an endpoint) is correct
          if (/^\s{4}rules:/.test(line)) {
            assert.fail(`${p.name} line ${i + 1}: rules at policy level (should be inside endpoint)`);
          }
        }
      }
    });

    it("every preset has network_policies section", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        assert.ok(content.includes("network_policies:"), `${p.name} missing network_policies`);
      }
    });
  });

  describe("new preset endpoints", () => {
    it("cargo preset has crates.io endpoints", () => {
      const content = policies.loadPreset("cargo");
      const hosts = policies.getPresetEndpoints(content);
      assert.ok(hosts.includes("crates.io"));
      assert.ok(hosts.includes("static.crates.io"));
      assert.ok(hosts.includes("index.crates.io"));
    });

    it("go preset has proxy and sum endpoints", () => {
      const content = policies.loadPreset("go");
      const hosts = policies.getPresetEndpoints(content);
      assert.ok(hosts.includes("proxy.golang.org"));
      assert.ok(hosts.includes("sum.golang.org"));
      assert.ok(hosts.includes("storage.googleapis.com"));
    });

    it("apt preset has ubuntu and debian endpoints", () => {
      const content = policies.loadPreset("apt");
      const hosts = policies.getPresetEndpoints(content);
      assert.ok(hosts.includes("archive.ubuntu.com"));
      assert.ok(hosts.includes("security.ubuntu.com"));
      assert.ok(hosts.includes("deb.debian.org"));
    });

    it("ghcr preset has registry endpoint", () => {
      const content = policies.loadPreset("ghcr");
      const hosts = policies.getPresetEndpoints(content);
      assert.ok(hosts.includes("ghcr.io"));
    });
  });
});
