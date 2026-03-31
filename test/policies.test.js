// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import policies from "../bin/lib/policies";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "bin", "nemoclaw.js"));
const CREDENTIALS_PATH = JSON.stringify(path.join(REPO_ROOT, "bin", "lib", "credentials.js"));
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "bin", "lib", "policies.js"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "bin", "lib", "registry.js"));
const SELECT_FROM_LIST_ITEMS = [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index (PyPI) access" },
];

function runPolicyAdd(confirmAnswer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-add-"));
  const scriptPath = path.join(tmpDir, "policy-add-check.js");
  const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
policies.selectFromList = async () => "pypi";
credentials.prompt = async (message) => {
  calls.push({ type: "prompt", message });
  return ${JSON.stringify(confirmAnswer)};
};
registry.getSandbox = (name) => (name === "test-sandbox" ? { name } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
policies.listPresets = () => [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index (PyPI) access" },
];
policies.getAppliedPresets = () => [];
policies.applyPreset = (sandboxName, presetName) => {
  calls.push({ type: "apply", sandboxName, presetName });
};
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-add"];
require(${CLI_PATH});
setImmediate(() => {
  process.stdout.write(JSON.stringify(calls));
});
`;

  fs.writeFileSync(scriptPath, script);

  return spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
    },
  });
}

function runSelectFromList(input, { applied = [] } = {}) {
  const script = String.raw`
const { selectFromList } = require(${POLICIES_PATH});
const items = JSON.parse(process.env.NEMOCLAW_TEST_ITEMS);
const options = JSON.parse(process.env.NEMOCLAW_TEST_OPTIONS || "{}");

selectFromList(items, options)
  .then((value) => {
    process.stdout.write(String(value) + "\n");
  })
  .catch((error) => {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(message);
    process.exit(1);
  });
`;

  return spawnSync(process.execPath, ["-e", script], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 5000,
    input,
    env: {
      ...process.env,
      NEMOCLAW_TEST_ITEMS: JSON.stringify(SELECT_FROM_LIST_ITEMS),
      NEMOCLAW_TEST_OPTIONS: JSON.stringify({ applied }),
    },
  });
}

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

  describe("selectFromList", () => {
    it("returns preset name by number from stdin input", () => {
      const result = runSelectFromList("1\n");

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("npm");
      expect(result.stderr).toContain("Choose preset [1]:");
    });

    it("uses the first preset as the default when input is empty", () => {
      const result = runSelectFromList("\n");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Choose preset [1]:");
      expect(result.stdout.trim()).toBe("npm");
    });

    it("defaults to the first not-applied preset", () => {
      const result = runSelectFromList("\n", { applied: ["npm"] });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Choose preset [2]:");
      expect(result.stdout.trim()).toBe("pypi");
    });

    it("rejects selecting an already-applied preset", () => {
      const result = runSelectFromList("1\n", { applied: ["npm"] });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Preset 'npm' is already applied.");
      expect(result.stdout.trim()).toBe("null");
    });

    it("rejects out-of-range preset number", () => {
      const result = runSelectFromList("99\n");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Invalid preset number.");
      expect(result.stdout.trim()).toBe("null");
    });

    it("rejects non-numeric preset input", () => {
      const result = runSelectFromList("npm\n");

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Invalid preset number.");
      expect(result.stdout.trim()).toBe("null");
    });

    it("prints numbered list with applied markers, legend, and default prompt", () => {
      const result = runSelectFromList("2\n", { applied: ["npm"] });

      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/Available presets:/);
      expect(result.stderr).toMatch(/1\) ● npm — npm and Yarn registry access/);
      expect(result.stderr).toMatch(/2\) ○ pypi — Python Package Index \(PyPI\) access/);
      expect(result.stderr).toMatch(/● applied, ○ not applied/);
      expect(result.stderr).toMatch(/Choose preset \[2\]:/);
      expect(result.stdout.trim()).toBe("pypi");
    });
  });

  describe("policy-add confirmation", () => {
    it("prompts for confirmation before applying a preset", () => {
      const result = runPolicyAdd("y");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.trim());
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Apply 'pypi' to sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("skips applying the preset when confirmation is declined", () => {
      const result = runPolicyAdd("n");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.trim());
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Apply 'pypi' to sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls.some((call) => call.type === "apply")).toBeFalsy();
    });
  });
});
