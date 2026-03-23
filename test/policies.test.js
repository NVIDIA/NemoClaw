// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import path from "node:path";
import policies from "../bin/lib/policies";

describe("policies", () => {
  describe("listPresets", () => {
    const expected = ["apt", "cargo", "discord", "docker", "ghcr", "go", "huggingface", "jira", "npm", "outlook", "pypi", "slack", "telegram"];

    it("returns all presets", () => {
      const presets = policies.listPresets();
      expect(presets.length).toBe(expected.length);
    });

    it("each preset has name and description", () => {
      for (const p of policies.listPresets()) {
        expect(p.name).toBeTruthy();
        expect(p.description).toBeTruthy();
      }
    });

    it("returns expected preset names", () => {
      const names = policies.listPresets().map((p) => p.name).sort();
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
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
      expect(cmd).toBe("openshell policy set --policy '/tmp/policy.yaml' --wait 'my-assistant'");
    });

    it("escapes shell metacharacters in sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test; whoami");
      expect(cmd.includes("'test; whoami'")).toBeTruthy();
    });

    it("places --wait before the sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test-box");
      const waitIdx = cmd.indexOf("--wait");
      const nameIdx = cmd.indexOf("'test-box'");
      expect(waitIdx < nameIdx).toBeTruthy();
    });
  });

  describe("buildPolicyGetCommand", () => {
    it("shell-quotes sandbox name", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      expect(cmd).toBe("openshell policy get --full 'my-assistant' 2>/dev/null");
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
              `${p.name} line ${i + 1}: rules at policy level (should be inside endpoint)`
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
  });

  describe("new preset endpoints", () => {
    it("cargo preset has crates.io endpoints", () => {
      const content = policies.loadPreset("cargo");
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts.includes("crates.io")).toBeTruthy();
      expect(hosts.includes("static.crates.io")).toBeTruthy();
      expect(hosts.includes("index.crates.io")).toBeTruthy();
    });

    it("go preset has proxy and sum endpoints", () => {
      const content = policies.loadPreset("go");
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts.includes("proxy.golang.org")).toBeTruthy();
      expect(hosts.includes("sum.golang.org")).toBeTruthy();
      expect(hosts.includes("storage.googleapis.com")).toBeTruthy();
    });

    it("apt preset has ubuntu and debian endpoints", () => {
      const content = policies.loadPreset("apt");
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts.includes("archive.ubuntu.com")).toBeTruthy();
      expect(hosts.includes("security.ubuntu.com")).toBeTruthy();
      expect(hosts.includes("deb.debian.org")).toBeTruthy();
    });

    it("ghcr preset has registry endpoint", () => {
      const content = policies.loadPreset("ghcr");
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts.includes("ghcr.io")).toBeTruthy();
    });
  });
});
