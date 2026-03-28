// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it, expect } from "vitest";
import policies from "../bin/lib/policies";

describe("policies", () => {
  describe("listPresets", () => {
    it("returns all 9 presets", () => {
      const presets = policies.listPresets();
      expect(presets.length).toBe(9);
    });

    it("each preset has name and description", () => {
      for (const p of policies.listPresets()) {
        expect(p.name).toBeTruthy();
        expect(p.description).toBeTruthy();
      }
    });

    it("returns expected preset names", () => {
      const names = policies
        .listPresets()
        .map((p) => p.name)
        .sort();
      const expected = [
        "discord",
        "docker",
        "huggingface",
        "jira",
        "npm",
        "outlook",
        "pypi",
        "slack",
        "telegram",
      ];
      expect(names).toEqual(expected);
    });
  });

  describe("loadPreset", () => {
    it("loads existing preset", () => {
      const content = policies.loadPreset("outlook");
      expect(content).toBeTruthy();
      expect(content.includes("network_policies:")).toBeTruthy();
    });

    it("returns null for nonexistent preset", () => {
      expect(policies.loadPreset("nonexistent")).toBe(null);
    });

    it("rejects path traversal attempts", () => {
      expect(policies.loadPreset("../../etc/passwd")).toBe(null);
      expect(policies.loadPreset("../../../etc/shadow")).toBe(null);
    });
  });

  describe("getPresetEndpoints", () => {
    it("extracts hosts from outlook preset", () => {
      const content = policies.loadPreset("outlook");
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts.includes("graph.microsoft.com")).toBeTruthy();
      expect(hosts.includes("login.microsoftonline.com")).toBeTruthy();
      expect(hosts.includes("outlook.office365.com")).toBeTruthy();
      expect(hosts.includes("outlook.office.com")).toBeTruthy();
    });

    it("extracts hosts from telegram preset", () => {
      const content = policies.loadPreset("telegram");
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts).toEqual(["api.telegram.org"]);
    });

    it("every preset has at least one endpoint", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        const hosts = policies.getPresetEndpoints(content);
        expect(hosts.length > 0).toBeTruthy();
      }
    });
  });

  describe("buildPolicySetCommand", () => {
    it("shell-quotes sandbox name to prevent injection", () => {
      const cmd = policies.buildPolicySetCommand(
        "/tmp/policy.yaml",
        "my-assistant",
      );
      expect(cmd).toBe(
        "openshell policy set --policy '/tmp/policy.yaml' --wait 'my-assistant'",
      );
    });

    it("escapes shell metacharacters in sandbox name", () => {
      const cmd = policies.buildPolicySetCommand(
        "/tmp/policy.yaml",
        "test; whoami",
      );
      expect(cmd.includes("'test; whoami'")).toBeTruthy();
    });

    it("places --wait before the sandbox name", () => {
      const cmd = policies.buildPolicySetCommand(
        "/tmp/policy.yaml",
        "test-box",
      );
      const waitIdx = cmd.indexOf("--wait");
      const nameIdx = cmd.indexOf("'test-box'");
      expect(waitIdx < nameIdx).toBeTruthy();
    });

    it("uses the resolved openshell binary when provided by the installer path", () => {
      process.env.NEMOCLAW_OPENSHELL_BIN = "/tmp/fake path/openshell";
      try {
        const cmd = policies.buildPolicySetCommand(
          "/tmp/policy.yaml",
          "my-assistant",
        );
        assert.equal(
          cmd,
          "'/tmp/fake path/openshell' policy set --policy '/tmp/policy.yaml' --wait 'my-assistant'",
        );
      } finally {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      }
    });
  });

  describe("buildPolicyGetCommand", () => {
    it("shell-quotes sandbox name", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      expect(cmd).toBe(
        "openshell policy get --full 'my-assistant' 2>/dev/null",
      );
    });
  });

  describe("extractPresetEntries", () => {
    it("returns null for null input", () => {
      expect(policies.extractPresetEntries(null)).toBe(null);
    });

    it("returns null for undefined input", () => {
      expect(policies.extractPresetEntries(undefined)).toBe(null);
    });

    it("returns null for empty string", () => {
      expect(policies.extractPresetEntries("")).toBe(null);
    });

    it("returns null when no network_policies section exists", () => {
      const content = "preset:\n  name: test\n  description: test preset";
      expect(policies.extractPresetEntries(content)).toBe(null);
    });

    it("extracts indented entries from network_policies section", () => {
      const content = [
        "preset:",
        "  name: test",
        "",
        "network_policies:",
        "  test_rule:",
        "    name: test_rule",
        "    endpoints:",
        "      - host: example.com",
        "        port: 443",
      ].join("\n");
      const entries = policies.extractPresetEntries(content);
      expect(entries).toContain("test_rule:");
      expect(entries).toContain("host: example.com");
      expect(entries).toContain("port: 443");
    });

    it("strips trailing whitespace from extracted entries", () => {
      const content = "network_policies:\n  rule:\n    name: rule\n\n\n";
      const entries = policies.extractPresetEntries(content);
      expect(entries).not.toMatch(/\n$/);
    });

    it("works on every real preset file", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        const entries = policies.extractPresetEntries(content);
        expect(entries).toBeTruthy();
        expect(entries).toContain("endpoints:");
      }
    });

    it("does not include preset metadata header", () => {
      const content = [
        "preset:",
        "  name: test",
        "  description: desc",
        "",
        "network_policies:",
        "  rule:",
        "    name: rule",
      ].join("\n");
      const entries = policies.extractPresetEntries(content);
      expect(entries).not.toContain("preset:");
      expect(entries).not.toContain("description:");
    });
  });

  describe("parseCurrentPolicy", () => {
    it("returns empty string for null input", () => {
      expect(policies.parseCurrentPolicy(null)).toBe("");
    });

    it("returns empty string for undefined input", () => {
      expect(policies.parseCurrentPolicy(undefined)).toBe("");
    });

    it("returns empty string for empty string input", () => {
      expect(policies.parseCurrentPolicy("")).toBe("");
    });

    it("strips metadata header before --- separator", () => {
      const raw = [
        "Version: 3",
        "Hash: abc123",
        "Updated: 2026-03-26",
        "---",
        "version: 1",
        "",
        "network_policies:",
        "  rule: {}",
      ].join("\n");
      const result = policies.parseCurrentPolicy(raw);
      expect(result).toBe("version: 1\n\nnetwork_policies:\n  rule: {}");
      expect(result).not.toContain("Hash:");
      expect(result).not.toContain("Updated:");
    });

    it("returns raw content when no --- separator exists", () => {
      const raw = "version: 1\nnetwork_policies:\n  rule: {}";
      expect(policies.parseCurrentPolicy(raw)).toBe(raw);
    });

    it("trims whitespace around extracted YAML", () => {
      const raw = "Header: value\n---\n  \nversion: 1\n  ";
      const result = policies.parseCurrentPolicy(raw);
      expect(result).toBe("version: 1");
    });

    it("handles --- appearing as first line", () => {
      const raw = "---\nversion: 1\nnetwork_policies: {}";
      const result = policies.parseCurrentPolicy(raw);
      expect(result).toBe("version: 1\nnetwork_policies: {}");
    });
  });

  describe("mergePresetIntoPolicy", () => {
    const sampleEntries = "  - host: example.com\n    allow: true";

    it("appends network_policies when current policy has content but no version header", () => {
      const versionless = "some_key:\n  foo: bar";
      const merged = policies.mergePresetIntoPolicy(versionless, sampleEntries);
      expect(merged.startsWith("version: 1\n")).toBe(true);
      expect(merged).toContain("some_key:");
      expect(merged).toContain("network_policies:");
      expect(merged).toContain("example.com");
    });

    it("appends preset entries when current policy has network_policies but no version", () => {
      const versionlessWithNp =
        "network_policies:\n  - host: existing.com\n    allow: true";
      const merged = policies.mergePresetIntoPolicy(versionlessWithNp, sampleEntries);
      expect(merged.trimStart().startsWith("version: 1\n")).toBe(true);
      expect(merged).toContain("existing.com");
      expect(merged).toContain("example.com");
    });

    it("keeps existing version when present", () => {
      const withVersion = "version: 2\n\nnetwork_policies:\n  - host: old.com";
      const merged = policies.mergePresetIntoPolicy(withVersion, sampleEntries);
      expect(merged).toContain("version: 2");
      expect(merged).toContain("example.com");
    });

    it("returns version + network_policies when current policy is empty", () => {
      const merged = policies.mergePresetIntoPolicy("", sampleEntries);
      expect(merged.startsWith("version: 1\n\nnetwork_policies:")).toBe(true);
      expect(merged).toContain("example.com");
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
            expect.unreachable(
              `${p.name} line ${i + 1}: rules at policy level (should be inside endpoint)`,
            );
          }
        }
      }
    });

    it("every preset has network_policies section", () => {
      for (const p of policies.listPresets()) {
        const content = policies.loadPreset(p.name);
        expect(content.includes("network_policies:")).toBeTruthy();
      }
    });

    it("package-manager presets use access: full (not tls: terminate)", () => {
      // Package managers (pip, npm, yarn) use CONNECT tunneling which breaks
      // under tls: terminate. Ensure these presets use access: full like the
      // github policy in openclaw-sandbox.yaml.
      const packagePresets = ["pypi", "npm"];
      for (const name of packagePresets) {
        const content = policies.loadPreset(name);
        expect(content).toBeTruthy();
        expect(content.includes("tls: terminate")).toBe(false);
        expect(content.includes("access: full")).toBe(true);
      }
    });

    it("package-manager presets include binaries section", () => {
      // Without binaries, the proxy can't match pip/npm traffic to the policy
      // and returns 403.
      const packagePresets = [
        { name: "pypi", expectedBinary: "python" },
        { name: "npm", expectedBinary: "npm" },
      ];
      for (const { name, expectedBinary } of packagePresets) {
        const content = policies.loadPreset(name);
        expect(content).toBeTruthy();
        expect(content.includes("binaries:")).toBe(true);
        expect(content.includes(expectedBinary)).toBe(true);
      }
    });
  });
});
