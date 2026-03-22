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

  describe("extractPresetEntries", () => {
    it("extracts network_policies entries from a real preset", () => {
      const content = policies.loadPreset("telegram");
      const entries = policies.extractPresetEntries(content);
      assert.ok(entries, "expected non-null entries");
      assert.ok(entries.includes("telegram_bot:"), "expected telegram_bot entry");
      assert.ok(entries.includes("api.telegram.org"), "expected telegram host");
      // Should NOT include the preset: metadata header
      assert.ok(!entries.includes("preset:"), "must strip preset metadata");
    });

    it("returns null when content has no network_policies key", () => {
      const content = "preset:\n  name: broken\n  description: test\n";
      assert.equal(policies.extractPresetEntries(content), null);
    });

    it("trims trailing whitespace from entries", () => {
      const content = "network_policies:\n  entry: value\n\n\n";
      const entries = policies.extractPresetEntries(content);
      assert.ok(entries);
      assert.ok(!entries.endsWith("\n"), "trailing newlines must be trimmed");
    });

    it("returns empty string when network_policies has no entries", () => {
      const content = "preset:\n  name: empty\nnetwork_policies:\n";
      const entries = policies.extractPresetEntries(content);
      assert.equal(entries, "");
    });
  });

  describe("parseCurrentPolicy", () => {
    it("returns empty string for falsy input", () => {
      assert.equal(policies.parseCurrentPolicy(""), "");
      assert.equal(policies.parseCurrentPolicy(null), "");
      assert.equal(policies.parseCurrentPolicy(undefined), "");
    });

    it("returns raw content when no --- separator", () => {
      const raw = "version: 1\nnetwork_policies:\n  test: value";
      assert.equal(policies.parseCurrentPolicy(raw), raw);
    });

    it("strips metadata header before --- separator", () => {
      const raw = "Version: 2\nHash: abc123\n---\nversion: 1\nnetwork_policies:\n  entry: value";
      const parsed = policies.parseCurrentPolicy(raw);
      assert.ok(parsed.startsWith("version: 1"), "must start with content after ---");
      assert.ok(!parsed.includes("Hash:"), "must not include metadata header");
    });

    it("splits on first --- only", () => {
      const raw = "Header\n---\nversion: 1\n---\nextra";
      const parsed = policies.parseCurrentPolicy(raw);
      assert.ok(parsed.includes("---"), "content after first --- may contain more ---");
      assert.ok(parsed.includes("extra"), "must preserve content after second ---");
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
