// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import policies from "../dist/lib/policies";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "bin", "nemoclaw.js"));
const CREDENTIALS_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "credentials.js"));
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "policies.js"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "registry.js"));
const SELECT_FROM_LIST_ITEMS = [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index (PyPI) access" },
];

type PolicyCall = {
  type: string;
  message?: string;
  sandboxName?: string;
  presetName?: string;
  path?: string;
};

type AppliedOptions = {
  applied?: string[];
};

function requirePresetContent(content: string | null): string {
  expect(content).toBeTruthy();
  if (!content) {
    throw new Error("Expected preset content to be present");
  }
  return content;
}

function runPolicyAdd(
  confirmAnswer: string,
  extraArgs: string[] = [],
  envOverrides: Record<string, string | undefined> = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-add-"));
  const scriptPath = path.join(tmpDir, "policy-add-check.js");
  const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
policies.selectFromList = async () => "pypi";
policies.loadPreset = () => "network_policies:\n  pypi:\n    host: pypi.org\n";
policies.getPresetEndpoints = () => ["pypi.org"];
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
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-add", ...${JSON.stringify(extraArgs)}];
require(${CLI_PATH});
setImmediate(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;

  fs.writeFileSync(scriptPath, script);

  return spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      ...envOverrides,
    },
  });
}

function runSelectFromList(input: string, { applied = [] }: AppliedOptions = {}) {
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
    timeout: Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 5000),
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
    it("returns all 12 presets", () => {
      const presets = policies.listPresets();
      expect(presets.length).toBe(12);
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
        "brave",
        "brew",
        "discord",
        "github",
        "huggingface",
        "jira",
        "local-inference",
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
      const content = requirePresetContent(policies.loadPreset("outlook"));
      expect(content.includes("network_policies:")).toBeTruthy();
    });

    it("returns null for nonexistent preset", () => {
      expect(policies.loadPreset("nonexistent")).toBe(null);
    });

    it("rejects path traversal attempts", () => {
      expect(policies.loadPreset("../../etc/passwd")).toBe(null);
      expect(policies.loadPreset("../../../etc/shadow")).toBe(null);
    });

    it("includes /usr/bin/node in communication presets", () => {
      for (const preset of ["discord", "slack", "telegram"]) {
        const content = requirePresetContent(policies.loadPreset(preset));
        expect(content).toContain("/usr/local/bin/node");
        expect(content).toContain("/usr/bin/node");
      }
    });

    it("local-inference preset targets host.openshell.internal on Ollama, proxy, and vLLM ports", () => {
      const content = requirePresetContent(policies.loadPreset("local-inference"));
      expect(content).toContain("host.openshell.internal");
      expect(content).toContain("port: 11434");
      expect(content).toContain("port: 11435");
      expect(content).toContain("port: 8000");
    });

    it("local-inference preset includes openclaw, claude, and common tool binaries", () => {
      const content = requirePresetContent(policies.loadPreset("local-inference"));
      expect(content).toContain("/usr/local/bin/openclaw");
      expect(content).toContain("/usr/local/bin/claude");
      // node, curl, and python3 are needed for direct inference access (#2199)
      expect(content).toContain("/usr/local/bin/node");
      expect(content).toContain("/usr/bin/curl");
      expect(content).toContain("/usr/bin/python3");
    });
  });

  describe("getPresetEndpoints", () => {
    it("extracts hosts from outlook preset", () => {
      const content = requirePresetContent(policies.loadPreset("outlook"));
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts.includes("graph.microsoft.com")).toBeTruthy();
      expect(hosts.includes("login.microsoftonline.com")).toBeTruthy();
      expect(hosts.includes("outlook.office365.com")).toBeTruthy();
      expect(hosts.includes("outlook.office.com")).toBeTruthy();
    });

    it("extracts hosts from telegram preset", () => {
      const content = requirePresetContent(policies.loadPreset("telegram"));
      const hosts = policies.getPresetEndpoints(content);
      expect(hosts).toEqual(["api.telegram.org"]);
    });

    it("every preset has at least one endpoint", () => {
      for (const p of policies.listPresets()) {
        const content = requirePresetContent(policies.loadPreset(p.name));
        const hosts = policies.getPresetEndpoints(content);
        expect(hosts.length > 0).toBeTruthy();
      }
    });

    it("strips surrounding quotes from hostnames", () => {
      const yaml = "host: \"example.com\"\n  host: 'other.com'";
      const hosts = policies.getPresetEndpoints(yaml);
      expect(hosts).toEqual(["example.com", "other.com"]);
    });
  });

  describe("applyPreset disclosure logging", () => {
    it("logs egress endpoints before applying", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });

      try {
        try {
          policies.applyPreset("test-sandbox", "npm");
        } catch {
          /* applyPreset may throw if sandbox not running — we only care about the log */
        }
        const messages = logSpy.mock.calls.map((call) =>
          typeof call[0] === "string" ? call[0] : undefined,
        );
        expect(
          messages.some((m) => typeof m === "string" && m.includes("Widening sandbox egress")),
        ).toBe(true);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it("does not log when preset does not exist", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        policies.applyPreset("test-sandbox", "nonexistent");
        const messages = logSpy.mock.calls.map((call) =>
          typeof call[0] === "string" ? call[0] : undefined,
        );
        expect(
          messages.some((m) => typeof m === "string" && m.includes("Widening sandbox egress")),
        ).toBe(false);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });

    it("does not log when preset exists but has no host entries", () => {
      const noHostPreset =
        "preset:\n  name: empty\n\nnetwork_policies:\n  empty_rule:\n    name: empty_rule\n    endpoints: []\n";
      const loadSpy = vi.spyOn(policies, "loadPreset").mockReturnValue(noHostPreset);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });

      try {
        try {
          policies.applyPreset("test-sandbox", "empty");
        } catch {
          /* applyPreset may throw if sandbox not running */
        }
        const messages = logSpy.mock.calls.map((call) =>
          typeof call[0] === "string" ? call[0] : undefined,
        );
        expect(
          messages.some((m) => typeof m === "string" && m.includes("Widening sandbox egress")),
        ).toBe(false);
      } finally {
        loadSpy.mockRestore();
        logSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  });

  describe("buildPolicySetCommand", () => {
    it("returns an argv array with sandbox name as a separate element", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
      expect(cmd).toEqual([
        "openshell",
        "policy",
        "set",
        "--policy",
        "/tmp/policy.yaml",
        "--wait",
        "my-assistant",
      ]);
    });

    it("preserves shell metacharacters literally in sandbox name (no injection)", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test; whoami");
      expect(cmd).toContain("test; whoami");
      // The metacharacters are a literal argv element, not shell-interpreted
    });

    it("places --wait before the sandbox name", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "test-box");
      const waitIdx = cmd.indexOf("--wait");
      const nameIdx = cmd.indexOf("test-box");
      expect(waitIdx < nameIdx).toBeTruthy();
    });

    it("uses the resolved openshell binary when provided by the installer path", () => {
      process.env.NEMOCLAW_OPENSHELL_BIN = "/tmp/fake path/openshell";
      try {
        const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
        expect(cmd).toEqual([
          "/tmp/fake path/openshell",
          "policy",
          "set",
          "--policy",
          "/tmp/policy.yaml",
          "--wait",
          "my-assistant",
        ]);
      } finally {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      }
    });
  });

  describe("buildPolicyGetCommand", () => {
    it("returns an argv array with sandbox name as a separate element", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      expect(cmd).toEqual(["openshell", "policy", "get", "--full", "my-assistant"]);
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
        const content = requirePresetContent(policies.loadPreset(p.name));
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

    it("drops metadata-only or truncated policy reads", () => {
      const raw = "Version: 3\nHash: abc123";
      expect(policies.parseCurrentPolicy(raw)).toBe("");
    });

    it("drops non-policy error output instead of treating it as YAML", () => {
      const raw = "Error: failed to parse sandbox policy YAML";
      expect(policies.parseCurrentPolicy(raw)).toBe("");
    });

    it("drops syntactically invalid or truncated YAML bodies", () => {
      const raw = "Version: 3\n---\nversion: 1\nnetwork_policies";
      expect(policies.parseCurrentPolicy(raw)).toBe("");
    });
  });

  describe("mergePresetIntoPolicy", () => {
    // Legacy list-style entries (backward compat — uses text-based fallback)
    const sampleEntries = "  - host: example.com\n    allow: true";

    it("appends network_policies when current policy has content but no version header", () => {
      const versionless = "some_key:\n  foo: bar";
      const merged = policies.mergePresetIntoPolicy(versionless, sampleEntries);
      expect(merged).toContain("version:");
      expect(merged).toContain("some_key:");
      expect(merged).toContain("network_policies:");
      expect(merged).toContain("example.com");
    });

    it("appends preset entries when current policy has network_policies but no version", () => {
      const versionlessWithNp = "network_policies:\n  - host: existing.com\n    allow: true";
      const merged = policies.mergePresetIntoPolicy(versionlessWithNp, sampleEntries);
      expect(merged).toContain("version:");
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
      expect(merged).toContain("version: 1");
      expect(merged).toContain("network_policies:");
      expect(merged).toContain("example.com");
    });

    it("rebuilds from a clean scaffold when current policy read is truncated", () => {
      const merged = policies.mergePresetIntoPolicy("Version: 3\nHash: abc123", sampleEntries);
      expect(merged).toBe(
        "version: 1\n\nnetwork_policies:\n  - host: example.com\n    allow: true",
      );
    });

    it("adds a blank line after synthesized version headers", () => {
      const merged = policies.mergePresetIntoPolicy("some_key:\n  foo: bar", sampleEntries);
      expect(merged.startsWith("version: 1\n\nsome_key:")).toBe(true);
    });

    // --- Structured merge tests (real preset format) ---
    const realisticEntries =
      "  pypi_access:\n" +
      "    name: pypi_access\n" +
      "    endpoints:\n" +
      "      - host: pypi.org\n" +
      "        port: 443\n" +
      "        access: full\n" +
      "    binaries:\n" +
      "      - { path: /usr/bin/python3* }\n";

    it("uses structured YAML merge for real preset entries", () => {
      const current =
        "version: 1\n\n" +
        "network_policies:\n" +
        "  npm_yarn:\n" +
        "    name: npm_yarn\n" +
        "    endpoints:\n" +
        "      - host: registry.npmjs.org\n" +
        "        port: 443\n" +
        "        access: full\n" +
        "    binaries:\n" +
        "      - { path: /usr/local/bin/npm* }\n";
      const merged = policies.mergePresetIntoPolicy(current, realisticEntries);
      expect(merged).toContain("npm_yarn");
      expect(merged).toContain("registry.npmjs.org");
      expect(merged).toContain("pypi_access");
      expect(merged).toContain("pypi.org");
      expect(merged).toContain("version: 1");
    });

    it("deduplicates on policy name collision (preset overrides existing)", () => {
      const current =
        "version: 1\n\n" +
        "network_policies:\n" +
        "  pypi_access:\n" +
        "    name: pypi_access\n" +
        "    endpoints:\n" +
        "      - host: old-pypi.example.com\n" +
        "        port: 443\n" +
        "        access: full\n" +
        "    binaries:\n" +
        "      - { path: /usr/bin/pip* }\n";
      const merged = policies.mergePresetIntoPolicy(current, realisticEntries);
      expect(merged).toContain("pypi.org");
      expect(merged).not.toContain("old-pypi.example.com");
    });

    it("preserves non-network sections during structured merge", () => {
      const current =
        "version: 1\n\n" +
        "filesystem_policy:\n" +
        "  include_workdir: true\n" +
        "  read_only:\n" +
        "    - /usr\n\n" +
        "process:\n" +
        "  run_as_user: sandbox\n\n" +
        "network_policies:\n" +
        "  existing:\n" +
        "    name: existing\n" +
        "    endpoints:\n" +
        "      - host: api.example.com\n" +
        "        port: 443\n" +
        "        access: full\n" +
        "    binaries:\n" +
        "      - { path: /usr/local/bin/node* }\n";
      const merged = policies.mergePresetIntoPolicy(current, realisticEntries);
      expect(merged).toContain("filesystem_policy");
      expect(merged).toContain("include_workdir");
      expect(merged).toContain("run_as_user: sandbox");
      expect(merged).toContain("existing");
      expect(merged).toContain("pypi_access");
    });
  });

  describe("preset YAML schema", () => {
    it("no preset has rules at NetworkPolicyRuleDef level", () => {
      // rules must be inside endpoints, not as sibling of endpoints/binaries
      for (const p of policies.listPresets()) {
        const content = requirePresetContent(policies.loadPreset(p.name));
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
        const content = requirePresetContent(policies.loadPreset(p.name));
        expect(content.includes("network_policies:")).toBeTruthy();
      }
    });

    it("package-manager presets use protocol: rest with read-only rules", () => {
      // Package managers only need read access to install packages.
      // Using access: full opens a raw CONNECT tunnel that allows
      // PUT/POST (publish, exfiltrate). Restrict via rest rules.
      const packagePresets = ["pypi", "npm"];
      for (const name of packagePresets) {
        const content = requirePresetContent(policies.loadPreset(name));
        expect(content).toBeTruthy();
        expect(content.includes("access: full")).toBe(false);
        expect(content.includes("protocol: rest")).toBe(true);
        expect(content.includes("method: GET")).toBe(true);
        // No write methods allowed
        expect(content.includes("method: PUT")).toBe(false);
        expect(content.includes("method: POST")).toBe(false);
        expect(content.includes("method: DELETE")).toBe(false);
      }
    });

    it("outlook preset allows PATCH on graph.microsoft.com", () => {
      // Microsoft Graph API uses PATCH for common email and calendar operations:
      // marking messages as read, updating drafts, modifying calendar events.
      const content = requirePresetContent(policies.loadPreset("outlook"));
      const graphSection = content.split("host: graph.microsoft.com")[1]?.split("- host:")[0] ?? "";
      expect(graphSection).toContain("method: PATCH");
    });

    it("messaging WebSocket presets keep tls: skip on gateway endpoints", () => {
      const cases = [
        { preset: "discord", pattern: /host:\s*gateway\.discord\.gg[\s\S]*?tls:\s*skip/ },
        { preset: "slack", pattern: /host:\s*wss-primary\.slack\.com[\s\S]*?tls:\s*skip/ },
        { preset: "slack", pattern: /host:\s*wss-backup\.slack\.com[\s\S]*?tls:\s*skip/ },
      ];

      for (const { preset, pattern } of cases) {
        const content = requirePresetContent(policies.loadPreset(preset));
        expect(content).toBeTruthy();
        expect(content).toMatch(pattern);
      }
    });

    it("telegram REST preset uses tls: terminate for L7 proxy", () => {
      const content = requirePresetContent(policies.loadPreset("telegram"));
      expect(content).toBeTruthy();
      expect(content).toMatch(
        /host:\s*api\.telegram\.org[\s\S]*?protocol:\s*rest[\s\S]*?tls:\s*terminate/,
      );
    });

    it("pypi preset allows HEAD for pip lazy-wheel metadata checks", () => {
      // pip and uv use HEAD requests for lazy wheel downloads and
      // range-request support. GET-only would break pip install.
      const content = requirePresetContent(policies.loadPreset("pypi"));
      expect(content.includes("method: HEAD")).toBe(true);
    });

    it("package-manager presets include binaries section", () => {
      // Without binaries, the proxy can't match pip/npm traffic to the policy
      // and returns 403.
      const packagePresets = [
        { name: "pypi", expectedBinary: "python" },
        { name: "npm", expectedBinary: "npm" },
      ];
      for (const { name, expectedBinary } of packagePresets) {
        const content = requirePresetContent(policies.loadPreset(name));
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

  describe("removePresetFromPolicy", () => {
    const pypiEntries =
      "  pypi:\n" +
      "    name: pypi\n" +
      "    endpoints:\n" +
      "      - host: pypi.org\n" +
      "        port: 443\n";

    it("removes preset keys from policy YAML", () => {
      const current =
        "version: 1\n\n" +
        "network_policies:\n" +
        "  npm_yarn:\n" +
        "    name: npm_yarn\n" +
        "    endpoints:\n" +
        "      - host: registry.npmjs.org\n" +
        "        port: 443\n" +
        "        access: full\n" +
        "  pypi:\n" +
        "    name: pypi\n" +
        "    endpoints:\n" +
        "      - host: pypi.org\n" +
        "        port: 443\n" +
        "        access: full\n";
      const result = policies.removePresetFromPolicy(current, pypiEntries);
      expect(result).toContain("npm_yarn");
      expect(result).toContain("registry.npmjs.org");
      expect(result).not.toContain("pypi");
    });

    it("preserves non-network sections when removing preset", () => {
      const current =
        "version: 1\n\n" +
        "filesystem_policy:\n" +
        "  include_workdir: true\n\n" +
        "network_policies:\n" +
        "  pypi:\n" +
        "    name: pypi\n" +
        "    endpoints:\n" +
        "      - host: pypi.org\n" +
        "        port: 443\n";
      const result = policies.removePresetFromPolicy(current, pypiEntries);
      expect(result).toContain("filesystem_policy");
      expect(result).toContain("include_workdir");
      expect(result).not.toContain("pypi");
    });

    it("returns scaffold when current policy is empty", () => {
      const result = policies.removePresetFromPolicy("", pypiEntries);
      expect(result).toContain("version: 1");
    });

    it("returns current policy unchanged when presetEntries is null", () => {
      const current = "version: 1\n\nnetwork_policies:\n  npm_yarn:\n    name: npm_yarn\n";
      const result = policies.removePresetFromPolicy(current, null);
      expect(result).toContain("npm_yarn");
    });

    it("handles removing all network policies", () => {
      const current =
        "version: 1\n\nnetwork_policies:\n  pypi:\n    name: pypi\n    endpoints:\n      - host: pypi.org\n";
      const result = policies.removePresetFromPolicy(current, pypiEntries);
      expect(result).toContain("version: 1");
      expect(result).toContain("network_policies");
      expect(result).not.toContain("pypi");
    });

    it("returns policy unchanged when network_policies is a legacy array", () => {
      const current = "version: 1\n\nnetwork_policies:\n  - host: pypi.org\n    allow: true\n";
      const result = policies.removePresetFromPolicy(current, pypiEntries);
      expect(result).toContain("pypi.org");
      expect(result).toContain("allow: true");
    });
  });

  describe("selectForRemoval", () => {
    function runSelectForRemoval(input: string, { applied = [] }: AppliedOptions = {}) {
      const script = String.raw`
const { selectForRemoval } = require(${POLICIES_PATH});
const items = JSON.parse(process.env.NEMOCLAW_TEST_ITEMS);
const options = JSON.parse(process.env.NEMOCLAW_TEST_OPTIONS || "{}");

selectForRemoval(items, options)
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
        timeout: Number(process.env.NEMOCLAW_EXEC_TIMEOUT || 5000),
        input,
        env: {
          ...process.env,
          NEMOCLAW_TEST_ITEMS: JSON.stringify(SELECT_FROM_LIST_ITEMS),
          NEMOCLAW_TEST_OPTIONS: JSON.stringify({ applied }),
        },
      });
    }

    it("returns null when no presets are applied", () => {
      const result = runSelectForRemoval("1\n", { applied: [] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("No presets are currently applied");
      expect(result.stdout.trim()).toBe("null");
    });

    it("shows only applied presets and returns selected name", () => {
      const result = runSelectForRemoval("1\n", { applied: ["npm"] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Applied presets:");
      expect(result.stderr).toContain("1) npm");
      expect(result.stderr).not.toContain("pypi");
      expect(result.stdout.trim()).toBe("npm");
    });

    it("returns null for empty input", () => {
      const result = runSelectForRemoval("\n", { applied: ["npm"] });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("null");
    });

    it("rejects non-numeric input", () => {
      const result = runSelectForRemoval("npm\n", { applied: ["npm"] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Invalid preset number");
      expect(result.stdout.trim()).toBe("null");
    });

    it("rejects out-of-range number", () => {
      const result = runSelectForRemoval("99\n", { applied: ["npm"] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Invalid preset number");
      expect(result.stdout.trim()).toBe("null");
    });

    it("selects second preset when both are applied", () => {
      const result = runSelectForRemoval("2\n", { applied: ["npm", "pypi"] });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("1) npm");
      expect(result.stderr).toContain("2) pypi");
      expect(result.stdout.trim()).toBe("pypi");
    });
  });

  describe("policy-add confirmation", () => {
    it("prompts for confirmation before applying a preset", () => {
      const result = runPolicyAdd("y");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
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
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Apply 'pypi' to sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls.some((call: PolicyCall) => call.type === "apply")).toBeFalsy();
    });

    it("does not prompt or apply when --dry-run is passed", () => {
      const result = runPolicyAdd("y", ["--dry-run"]);

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls.some((call: PolicyCall) => call.type === "apply")).toBeFalsy();
      expect(result.stdout).toMatch(/Endpoints that would be opened: pypi\.org/);
      expect(result.stdout).toMatch(/--dry-run: no changes applied\./);
    });

    it("accepts a preset name with --yes for headless use", () => {
      const result = runPolicyAdd("n", ["pypi", "--yes"]);

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("honors non-interactive mode when a preset name is provided", () => {
      const result = runPolicyAdd("n", ["pypi"], { NEMOCLAW_NON_INTERACTIVE: "1" });

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("fails fast in non-interactive mode without a preset name", () => {
      const result = runPolicyAdd("y", [], { NEMOCLAW_NON_INTERACTIVE: "1" });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /Non-interactive mode requires a preset name/,
      );
    });
  });

  describe("policy-remove confirmation", () => {
    function runPolicyRemove(
      confirmAnswer: string,
      extraArgs: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
    ) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-remove-"));
      const scriptPath = path.join(tmpDir, "policy-remove-check.js");
      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
policies.selectForRemoval = async () => "pypi";
policies.loadPreset = () => "network_policies:\n  pypi:\n    host: pypi.org\n";
policies.getPresetEndpoints = () => ["pypi.org"];
credentials.prompt = async (message) => {
  calls.push({ type: "prompt", message });
  return ${JSON.stringify(confirmAnswer)};
};
registry.getSandbox = (name) => (name === "test-sandbox" ? { name, policies: ["pypi"] } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
policies.listPresets = () => [
  { name: "npm", description: "npm and Yarn registry access" },
  { name: "pypi", description: "Python Package Index (PyPI) access" },
];
policies.listCustomPresets = () => [];
policies.getAppliedPresets = () => ["pypi"];
policies.removePreset = (sandboxName, presetName) => {
  calls.push({ type: "remove", sandboxName, presetName });
  return true;
};
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-remove", ...${JSON.stringify(extraArgs)}];
require(${CLI_PATH});
setImmediate(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;

      fs.writeFileSync(scriptPath, script);

      return spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: tmpDir,
          ...envOverrides,
        },
      });
    }

    it("prompts for confirmation before removing a preset", () => {
      const result = runPolicyRemove("y");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Remove 'pypi' from sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("skips removing the preset when confirmation is declined", () => {
      const result = runPolicyRemove("n");

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "prompt",
        message: "  Remove 'pypi' from sandbox 'test-sandbox'? [Y/n]: ",
      });
      expect(calls.some((call: PolicyCall) => call.type === "remove")).toBeFalsy();
    });

    it("does not prompt or remove when --dry-run is passed", () => {
      const result = runPolicyRemove("y", ["--dry-run"]);

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls.some((call: PolicyCall) => call.type === "remove")).toBeFalsy();
      expect(result.stdout).toMatch(/Endpoints that would be removed: pypi\.org/);
      expect(result.stdout).toMatch(/--dry-run: no changes applied\./);
    });

    it("accepts a preset name with --yes for scripted removal", () => {
      const result = runPolicyRemove("n", ["pypi", "--yes"]);

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("honors non-interactive mode when removing an explicit preset", () => {
      const result = runPolicyRemove("n", ["pypi"], { NEMOCLAW_NON_INTERACTIVE: "1" });

      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });

    it("fails fast in non-interactive mode without a preset name", () => {
      const result = runPolicyRemove("y", [], { NEMOCLAW_NON_INTERACTIVE: "1" });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /Non-interactive mode requires a preset name/,
      );
    });

    it("accepts -y as an alias for --yes", () => {
      const result = runPolicyRemove("n", ["pypi", "-y"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((call: PolicyCall) => call.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "pypi",
      });
    });
  });

  describe("policy-remove custom presets", () => {
    function runPolicyRemoveCustom(
      presetName: string,
      extraArgs: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
    ) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-remove-custom-"));
      const scriptPath = path.join(tmpDir, "policy-remove-custom-check.js");
      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
// No built-in matches.
policies.listPresets = () => [];
policies.listCustomPresets = () => [
  { file: "/tmp/my-api.yaml", name: "my-api", description: "custom preset" },
];
policies.getAppliedPresets = () => ["my-api"];
policies.loadPreset = () => null; // built-in lookup misses
policies.getPresetEndpoints = () => ["api.example.internal"];
policies.removePreset = (sandboxName, presetName) => {
  calls.push({ type: "remove", sandboxName, presetName });
  return true;
};
registry.getSandbox = (name) =>
  name === "test-sandbox" ? { name, policies: [], customPolicies: [] } : null;
registry.getCustomPolicies = () => [
  { name: "my-api", content: "network_policies:\n  my-api: {}\n", sourcePath: "/tmp/my-api.yaml" },
];
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
credentials.prompt = async () => "y";
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-remove", ${JSON.stringify(presetName)}, ...${JSON.stringify(extraArgs)}];
require(${CLI_PATH});
setImmediate(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;
      fs.writeFileSync(scriptPath, script);
      return spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir, ...envOverrides },
      });
    }

    it("removes a custom preset by name using registry-persisted content", () => {
      const result = runPolicyRemoveCustom("my-api", ["--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({
        type: "remove",
        sandboxName: "test-sandbox",
        presetName: "my-api",
      });
      expect(result.stdout).toMatch(/api\.example\.internal/);
    });

    it("rejects an unknown preset name even when no built-ins are defined", () => {
      const result = runPolicyRemoveCustom("bogus", ["--yes"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Unknown preset 'bogus'/);
    });
  });

  describe("loadPresetFromFile", () => {
    function writeTmp(body: string, ext = "yaml") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preset-"));
      const file = path.join(dir, `custom.${ext}`);
      fs.writeFileSync(file, body);
      return { dir, file };
    }

    it("loads a valid custom preset and returns its declared name", () => {
      const body = [
        "preset:",
        "  name: custom-rule",
        "  description: custom",
        "network_policies:",
        "  custom-rule:",
        "    name: custom-rule",
        "    endpoints:",
        "      - host: custom.example.com",
        "        port: 443",
      ].join("\n");
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const loaded = policies.loadPresetFromFile(file);
        expect(loaded).toBeTruthy();
        expect(loaded!.presetName).toBe("custom-rule");
        expect(loaded!.content).toContain("custom.example.com");
      } finally {
        errSpy.mockRestore();
      }
    });

    it("returns null when the file does not exist", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile("/definitely/not/a/file.yaml")).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes("not found"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects non-yaml file extensions", () => {
      const { file } = writeTmp("preset:\n  name: ok\nnetwork_policies:\n  r: {}", "txt");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes(".yaml or .yml"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects invalid YAML", () => {
      const { file } = writeTmp(": : :\nfoo: [unclosed");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes("Invalid YAML"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects preset missing preset.name", () => {
      const body = "preset:\n  description: no name\nnetwork_policies:\n  r:\n    name: r\n";
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(
          msgs.some((m) => typeof m === "string" && m.includes("must declare preset.name")),
        ).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects preset.name that is not an RFC 1123 label", () => {
      const body = "preset:\n  name: Has_Underscore\nnetwork_policies:\n  r:\n    name: r\n";
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects preset missing network_policies", () => {
      const body = "preset:\n  name: ok\n";
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(
          msgs.some((m) => typeof m === "string" && m.includes("missing network_policies")),
        ).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects a preset name that collides with a built-in", () => {
      const body = "preset:\n  name: slack\nnetwork_policies:\n  r:\n    name: r\n";
      const { file } = writeTmp(body);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(
          msgs.some((m) => typeof m === "string" && m.includes("collides with a built-in")),
        ).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("policy-add --from-file / --from-dir", () => {
    function runPolicyAddExternal(
      extraArgs: string[] = [],
      envOverrides: Record<string, string | undefined> = {},
      promptAnswer = "y",
    ) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-external-"));
      const scriptPath = path.join(tmpDir, "policy-add-external.js");
      const script = String.raw`
const registry = require(${POLICIES_PATH.replace("policies.js", "registry.js")});
const policies = require(${POLICIES_PATH});
const credentials = require(${CREDENTIALS_PATH});
const calls = [];
policies.selectFromList = async () => null;
policies.listPresets = () => [];
policies.getAppliedPresets = () => [];
policies.loadPresetFromFile = (p) => {
  calls.push({ type: "load", path: p });
  if (String(p).includes("bad")) return null;
  const m = String(p).match(/([a-z0-9-]+)\.yaml$/);
  const name = m ? m[1] : "unknown";
  return { presetName: name, content: "network_policies:\n  " + name + ":\n    host: " + name + ".example.com\n" };
};
policies.applyPresetContent = (sandboxName, presetName) => {
  calls.push({ type: "apply", sandboxName, presetName });
  return true;
};
policies.getPresetEndpoints = (content) => {
  const m = String(content).match(/host:\s*([^\s]+)/);
  return m ? [m[1]] : [];
};
credentials.prompt = async (message) => {
  calls.push({ type: "prompt", message });
  return ${JSON.stringify(promptAnswer)};
};
registry.getSandbox = (name) => (name === "test-sandbox" ? { name } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-add", ...${JSON.stringify(extraArgs)}];
require(${CLI_PATH});
setImmediate(() => {
  process.stdout.write("\n__CALLS__" + JSON.stringify(calls));
});
`;
      fs.writeFileSync(scriptPath, script);
      return spawnSync(process.execPath, [scriptPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir, ...envOverrides },
      });
    }

    it("applies a custom preset when --from-file and --yes are provided", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(
        file,
        "preset:\n  name: custom-rule\nnetwork_policies:\n  custom-rule:\n    name: r\n",
      );
      const result = runPolicyAddExternal(["--from-file", file, "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls).toContainEqual({ type: "load", path: file });
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "custom-rule",
      });
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
    });

    it("exits non-zero when --from-file points to an unreadable preset", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-bad-"));
      const file = path.join(tmp, "bad.yaml");
      fs.writeFileSync(file, "preset:\n  name: ignored\n");
      const result = runPolicyAddExternal(["--from-file", file, "--yes"]);
      expect(result.status).not.toBe(0);
    });

    it("does not apply and does not prompt under --from-file --dry-run", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-dry-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file, "--dry-run", "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "apply")).toBeFalsy();
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
      expect(result.stdout).toMatch(/--dry-run: 'custom-rule' not applied\./);
    });

    it("skips the confirmation prompt when NEMOCLAW_NON_INTERACTIVE=1", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-env-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file], { NEMOCLAW_NON_INTERACTIVE: "1" });
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "prompt")).toBeFalsy();
      expect(calls).toContainEqual({
        type: "apply",
        sandboxName: "test-sandbox",
        presetName: "custom-rule",
      });
    });

    it("does not apply an external preset when the confirmation prompt is declined", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-file-no-"));
      const file = path.join(tmp, "custom-rule.yaml");
      fs.writeFileSync(file, "preset:\n  name: custom-rule\nnetwork_policies: {}\n");
      const result = runPolicyAddExternal(["--from-file", file], {}, "no");
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      expect(calls.some((c) => c.type === "prompt")).toBeTruthy();
      expect(calls.some((c) => c.type === "apply")).toBeFalsy();
    });

    it("errors when --from-file and --from-dir are combined", () => {
      const result = runPolicyAddExternal(["--from-file", "a.yaml", "--from-dir", "b"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/mutually exclusive/);
    });

    it("errors when --from-file is missing its path argument", () => {
      const result = runPolicyAddExternal(["--from-file"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/--from-file requires a path argument/);
    });

    it("applies every preset in --from-dir in sorted order and aborts on the first failure", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-dir-"));
      fs.writeFileSync(
        path.join(dir, "a-good.yaml"),
        "preset:\n  name: a-good\nnetwork_policies: {}\n",
      );
      fs.writeFileSync(
        path.join(dir, "b-bad.yaml"),
        "preset:\n  name: b-bad\nnetwork_policies: {}\n",
      );
      fs.writeFileSync(
        path.join(dir, "c-skipped.yaml"),
        "preset:\n  name: c-skipped\nnetwork_policies: {}\n",
      );
      const result = runPolicyAddExternal(["--from-dir", dir, "--yes"]);
      expect(result.status).not.toBe(0);
      // a-good succeeded (visible as the [a-good] endpoints log), b-bad triggered abort,
      // c-skipped was never loaded because the loop stopped at b-bad.
      expect(result.stdout).toMatch(/\[a-good\] Endpoints that would be opened/);
      expect(result.stdout).not.toMatch(/\[c-skipped\]/);
      expect(result.stderr).toMatch(/Aborting --from-dir/);
    });

    it("errors when --from-dir points at a non-directory", () => {
      const result = runPolicyAddExternal(["--from-dir", "/does/not/exist"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Directory not found/);
    });

    it("--from-dir skips sub-directories whose names end in .yaml/.yml", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-from-dir-skipdir-"));
      // A real preset file and a directory that happens to match the yaml glob.
      fs.writeFileSync(
        path.join(dir, "real.yaml"),
        "preset:\n  name: real\nnetwork_policies: {}\n",
      );
      fs.mkdirSync(path.join(dir, "archived.yaml"));
      const result = runPolicyAddExternal(["--from-dir", dir, "--yes"]);
      expect(result.status).toBe(0);
      const calls = JSON.parse(result.stdout.split("__CALLS__")[1].trim()) as PolicyCall[];
      // Only the real file should have been loaded.
      const loads = calls.filter((c) => c.type === "load").map((c) => c.path);
      expect(loads.length).toBe(1);
      expect(loads[0]).toMatch(/real\.yaml$/);
    });
  });
});
