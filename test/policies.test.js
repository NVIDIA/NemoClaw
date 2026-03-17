// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const policies = require("../bin/lib/policies");

describe("policies", () => {
  describe("listPresets", () => {
    it("returns all 9 presets", () => {
      const presets = policies.listPresets();
      assert.equal(presets.length, 9);
    });

    it("each preset has name and description", () => {
      for (const p of policies.listPresets()) {
        assert.ok(p.name, `preset missing name: ${p.file}`);
        assert.ok(p.description, `preset missing description: ${p.file}`);
      }
    });

    it("returns expected preset names", () => {
      const names = policies.listPresets().map((p) => p.name).sort();
      const expected = ["discord", "docker", "huggingface", "jira", "npm", "outlook", "pypi", "slack", "telegram"];
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

    it("rejects path traversal attempts", () => {
      assert.equal(policies.loadPreset("../../etc/passwd"), null);
      assert.equal(policies.loadPreset("../../../etc/shadow"), null);
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
    it("shell-quotes sandbox name to prevent injection", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
      assert.equal(cmd, "openshell policy set --policy '/tmp/policy.yaml' --wait 'my-assistant'");
    });

    it("escapes shell metacharacters in sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test; whoami");
      assert.ok(cmd.includes("'test; whoami'"), "metacharacters must be shell-quoted");
    });

    it("places --wait before the sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test-box");
      const waitIdx = cmd.indexOf("--wait");
      const nameIdx = cmd.indexOf("'test-box'");
      assert.ok(waitIdx < nameIdx, "--wait must come before sandbox name");
    });
  });

  describe("buildPolicyGetCommand", () => {
    it("shell-quotes sandbox name", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      assert.equal(cmd, "openshell policy get --full 'my-assistant' 2>/dev/null");
    });
  });

  describe("mergePresetIntoPolicy", () => {
    const sampleEntries = "  - host: example.com\n    allow: true";

    it("appends network_policies when current policy has content but no version header", () => {
      const versionless = "some_key:\n  foo: bar";
      const merged = policies.mergePresetIntoPolicy(versionless, sampleEntries);
      assert.ok(merged.startsWith("version: 1\n"), "merged must start with version header");
      assert.ok(merged.includes("some_key:"), "merged must preserve existing content");
      assert.ok(merged.includes("network_policies:"), "merged must include network_policies section");
      assert.ok(merged.includes("example.com"), "merged must include preset entries");
    });

    it("appends preset entries when current policy has network_policies but no version", () => {
      const versionlessWithNp =
        "network_policies:\n  - host: existing.com\n    allow: true";
      const merged = policies.mergePresetIntoPolicy(versionlessWithNp, sampleEntries);
      assert.ok(merged.trimStart().startsWith("version: 1\n"), "merged must have version header");
      assert.ok(merged.includes("existing.com"), "merged must preserve existing entries");
      assert.ok(merged.includes("example.com"), "merged must include new preset entries");
    });

    it("keeps existing version when present", () => {
      const withVersion = "version: 2\n\nnetwork_policies:\n  - host: old.com";
      const merged = policies.mergePresetIntoPolicy(withVersion, sampleEntries);
      assert.ok(merged.includes("version: 2"), "merged must keep existing version");
      assert.ok(merged.includes("example.com"), "merged must include preset entries");
    });

    it("returns version + network_policies when current policy is empty", () => {
      const merged = policies.mergePresetIntoPolicy("", sampleEntries);
      assert.ok(merged.startsWith("version: 1\n\nnetwork_policies:"), "empty policy gets version and section");
      assert.ok(merged.includes("example.com"), "merged must include preset entries");
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
});
