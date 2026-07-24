// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Interface as ReadlineInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireForTest = createRequire(import.meta.url);
const readline = requireForTest("node:readline") as typeof import("node:readline");
const YAML = requireForTest("yaml");
const REPO_ROOT = path.join(import.meta.dirname, "..");
const policies = requireForTest(
  path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");
const resolveOpenshellModule = requireForTest(
  path.join(REPO_ROOT, "src", "lib", "adapters", "openshell", "resolve.ts"),
) as { resolveOpenshell: (...args: unknown[]) => string | null };
const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"));
const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"));
const SOURCE_NODE_ARGS = ["--import", "tsx"];
const SELECT_FROM_LIST_ITEMS = [
  { name: "npm", description: "npm and Yarn registry access", file: "npm.yaml" },
  { name: "pypi", description: "Python Package Index (PyPI) access", file: "pypi.yaml" },
];
type AppliedOptions = {
  applied?: string[];
};

type SelectionFunction = "selectFromList" | "selectForRemoval";

async function runSelectionPrompt(
  functionName: SelectionFunction,
  input: string,
  { applied = [] }: AppliedOptions = {},
) {
  const stderr: string[] = [];
  const counts = { ref: 0, pause: 0, unref: 0 };
  const stdin = process.stdin as typeof process.stdin & {
    ref: () => typeof process.stdin;
    pause: () => typeof process.stdin;
    unref: () => typeof process.stdin;
  };
  const original = {
    ref: stdin.ref,
    pause: stdin.pause,
    unref: stdin.unref,
  };
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const close = vi.fn();
  const createInterface = vi.spyOn(readline, "createInterface").mockImplementation((options) => {
    expect(options).toEqual({ input: process.stdin, output: process.stderr });
    return {
      question: (question: string, callback: (answer: string) => void) => {
        process.stderr.write(question);
        callback(input);
      },
      close,
    } as unknown as ReadlineInterface;
  });
  stdin.ref = () => {
    counts.ref += 1;
    return process.stdin;
  };
  stdin.pause = () => {
    counts.pause += 1;
    return process.stdin;
  };
  stdin.unref = () => {
    counts.unref += 1;
    return process.stdin;
  };

  try {
    const selected = await policies[functionName](SELECT_FROM_LIST_ITEMS, { applied });
    return {
      selected,
      stderr: stderr.join(""),
      counts,
      close,
    };
  } finally {
    stdin.ref = original.ref;
    stdin.pause = original.pause;
    stdin.unref = original.unref;
    createInterface.mockRestore();
    stderrWrite.mockRestore();
  }
}

function requirePresetContent(content: string | null): string {
  expect(content).toBeTruthy();
  if (!content) {
    throw new Error("Expected preset content to be present");
  }
  return content;
}

function parseResultPayload(stdout: string): any {
  const marker = "__RESULT__";
  const markerIndex = stdout.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(markerIndex + marker.length));
}

describe("policies", () => {
  describe("listPresets", () => {
    it("each preset has name and description", () => {
      for (const p of policies.listPresets()) {
        expect(p.name).toBeTruthy();
        expect(p.description).toBeTruthy();
      }
    });

    it("does not include the WhatsApp preset YAML body in the description", () => {
      const whatsapp = policies.listPresets().find((p) => p.name === "whatsapp");
      expect(whatsapp?.description).toBe(
        "WhatsApp Web WebSocket, media access, and a narrowly scoped Baileys protocol-version fetch from raw.githubusercontent.com",
      );
      expect(whatsapp?.description).not.toContain("network_policies:");
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
  });

  describe("getPresetEndpoints", () => {
    it("strips surrounding quotes from hostnames", () => {
      const yaml = "host: \"example.com\"\n  host: 'other.com'";
      const hosts = policies.getPresetEndpoints(yaml);
      expect(hosts).toEqual(["example.com", "other.com"]);
    });

    it("ignores commented host examples and inline comments", () => {
      const yaml = [
        "# matches `host:` as text",
        "  # host: commented.example.com",
        "  - host: real.example.com # host: ignored.example.com",
      ].join("\n");
      const hosts = policies.getPresetEndpoints(yaml);
      expect(hosts).toEqual(["real.example.com"]);
    });
  });

  describe("getPresetValidationWarning", () => {
    it("returns a warning for the telegram preset that mentions re-running onboard", () => {
      const warning = policies.getPresetValidationWarning("telegram");
      expect(warning).toBeTruthy();
      expect(warning).toContain("telegram");
      expect(warning).toContain("Telegram");
      expect(warning).toContain("nemoclaw onboard");
    });

    it("returns a warning for discord, slack, and wechat", () => {
      expect(policies.getPresetValidationWarning("discord")).toContain("Discord");
      expect(policies.getPresetValidationWarning("slack")).toContain("Slack");
      expect(policies.getPresetValidationWarning("wechat")).toContain("WeChat");
    });

    it("adds Discord validation guidance for Node probes instead of curl or DNS-only checks", () => {
      const warning = policies.getPresetValidationWarning("discord");

      expect(warning).toContain("curl");
      expect(warning).toContain("preset binary allowlist");
      expect(warning).toContain("Node HTTPS");
      expect(warning).toContain("https://discord.com/api/v10/gateway");
      expect(warning).toContain('dns.resolve("gateway.discord.gg")');
    });

    it("adds Jira validation guidance that makes blocked versus redirected curl observable", () => {
      const warning = policies.getPresetValidationWarning("jira");

      expect(warning).toContain("inconclusive before or after approval");
      expect(warning).toContain("api.atlassian.com/oauth/token/accessible-resources");
      expect(warning).toContain("401 JSON");
      expect(warning).toContain("Node HTTPS");
      expect(warning).toContain("https://api.atlassian.com");
    });

    it("returns null for presets without extra validation guidance", () => {
      expect(policies.getPresetValidationWarning("npm")).toBeNull();
      expect(policies.getPresetValidationWarning("pypi")).toBeNull();
      expect(policies.getPresetValidationWarning("github")).toBeNull();
      expect(policies.getPresetValidationWarning("brew")).toBeNull();
    });

    it("returns null for unknown preset names", () => {
      expect(policies.getPresetValidationWarning("")).toBeNull();
      expect(policies.getPresetValidationWarning("nonexistent")).toBeNull();
    });
  });

  describe("applyPresets", () => {
    it("merges built-in presets and submits one policy update", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-batch-"));
      const fakeOpenshell = path.join(tmpDir, "openshell");
      const callsPath = path.join(tmpDir, "calls.log");
      const policyOut = path.join(tmpDir, "policy.yaml");
      const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({ name: "test-sandbox", policies: [] });
const result = policies.applyPresets("test-sandbox", ["npm", "pypi"]);
process.stdout.write("\n__RESULT__" + JSON.stringify({
  result,
  calls: fs.readFileSync(process.env.CALLS_PATH, "utf-8").trim().split("\n").filter(Boolean),
  policy: fs.readFileSync(process.env.POLICY_OUT, "utf-8"),
  registry: registry.getSandbox("test-sandbox"),
}));
`;
      fs.writeFileSync(
        fakeOpenshell,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\n\nnetwork_policies: {}\n'
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  policy_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      policy_file="$2"
      break
    fi
    shift
  done
  cp "$policy_file" ${JSON.stringify(policyOut)}
  printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
            CALLS_PATH: callsPath,
            POLICY_OUT: policyOut,
          },
        });

        expect(result.status).toBe(0);
        const payload = parseResultPayload(result.stdout);
        expect(payload.result).toBe(true);
        expect(payload.calls.filter((call: string) => call.startsWith("policy get "))).toHaveLength(
          1,
        );
        expect(payload.calls.filter((call: string) => call.startsWith("policy set "))).toHaveLength(
          1,
        );
        expect(payload.policy).toContain("npm_yarn:");
        expect(payload.policy).toContain("pypi:");
        expect(payload.registry.policies).toEqual(["npm", "pypi"]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses agent-specific preset content for Hermes Discord", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-hermes-"));
      const fakeOpenshell = path.join(tmpDir, "openshell");
      const policyOut = path.join(tmpDir, "policy.yaml");
      const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({ name: "hermes-sandbox", agent: "hermes", policies: [] });
const result = policies.applyPresets("hermes-sandbox", ["discord"]);
process.stdout.write("\n__RESULT__" + JSON.stringify({
  result,
  policy: fs.readFileSync(process.env.POLICY_OUT, "utf-8"),
  registry: registry.getSandbox("hermes-sandbox"),
}));
`;
      fs.writeFileSync(
        fakeOpenshell,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\n\nnetwork_policies: {}\n'
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  policy_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      policy_file="$2"
      break
    fi
    shift
  done
  cp "$policy_file" ${JSON.stringify(policyOut)}
  printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
            POLICY_OUT: policyOut,
          },
        });

        expect(result.status).toBe(0);
        const payload = parseResultPayload(result.stdout);
        const parsed = YAML.parse(payload.policy);
        const discordPolicy = parsed.network_policies.discord;
        const binaries = discordPolicy.binaries.map((entry: { path: string }) => entry.path);
        expect(binaries).toContain("/usr/bin/python3*");
        expect(binaries).toContain("/opt/hermes/.venv/bin/python");
        const discordCom = discordPolicy.endpoints.find(
          (endpoint: { host?: string }) => endpoint.host === "discord.com",
        );
        const mutationRules = discordCom.rules
          .map((rule: { allow?: { method?: string; path?: string } }) => rule.allow)
          .filter((rule: { method?: string } | undefined) =>
            ["PUT", "PATCH", "DELETE"].includes(rule?.method || ""),
          );
        expect(mutationRules).toContainEqual({
          method: "PATCH",
          path: "/api/v*/channels/*/messages/*",
        });
        expect(mutationRules).not.toContainEqual({ method: "PATCH", path: "/**" });
        expect(payload.registry.policies).toEqual(["discord"]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses agent-specific preset aliases for Hermes WeChat", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-hermes-wechat-"));
      const fakeOpenshell = path.join(tmpDir, "openshell");
      const policyOut = path.join(tmpDir, "policy.yaml");
      const script = String.raw`
const fs = require("node:fs");
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});
registry.registerSandbox({ name: "hermes-sandbox", agent: "hermes", policies: [] });
const result = policies.applyPresets("hermes-sandbox", ["wechat"]);
process.stdout.write("\n__RESULT__" + JSON.stringify({
  result,
  policy: fs.readFileSync(process.env.POLICY_OUT, "utf-8"),
  registry: registry.getSandbox("hermes-sandbox"),
}));
`;
      fs.writeFileSync(
        fakeOpenshell,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1 $2" = "policy get" ]; then
  printf 'Version: 1\nHash: test\n---\nversion: 1\n\nnetwork_policies: {}\n'
  exit 0
fi
if [ "$1 $2" = "policy set" ]; then
  policy_file=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--policy" ]; then
      policy_file="$2"
      break
    fi
    shift
  done
  cp "$policy_file" ${JSON.stringify(policyOut)}
  printf 'Policy version 2 submitted\nPolicy version 2 loaded\n'
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );

      try {
        const result = spawnSync(process.execPath, [...SOURCE_NODE_ARGS, "-e", script], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            NEMOCLAW_OPENSHELL_BIN: fakeOpenshell,
            POLICY_OUT: policyOut,
          },
        });

        expect(result.status).toBe(0);
        const payload = parseResultPayload(result.stdout);
        const parsed = YAML.parse(payload.policy);
        expect(parsed.network_policies.wechat).toBeUndefined();
        const wechatPolicy = parsed.network_policies.wechat_bridge;
        const binaries = wechatPolicy.binaries.map((entry: { path: string }) => entry.path);
        expect(binaries).toContain("/usr/bin/python3*");
        expect(binaries).toContain("/opt/hermes/.venv/bin/python");
        expect(payload.registry.policies).toEqual(["wechat"]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("applyPreset disclosure logging", () => {
    const hasScopeHeader = (m: unknown): m is string =>
      typeof m === "string" && m.includes("Effective egress that would be opened");

    it("logs egress endpoints before applying", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-disclosure-"));
      const fakeOpenshell = path.join(tmpDir, "openshell");
      fs.writeFileSync(
        fakeOpenshell,
        "#!/bin/sh\nprintf 'version: 1\\nnetwork_policies: {}\\n'\nexit 0\n",
        { mode: 0o755 },
      );
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", fakeOpenshell);
      try {
        try {
          policies.applyPreset("test-sandbox", "npm");
        } catch {
          /* applyPreset may throw if sandbox not running — we only care about the log */
        }
        const messages = logSpy.mock.calls.map((call) =>
          typeof call[0] === "string" ? call[0] : undefined,
        );
        expect(messages.some(hasScopeHeader)).toBe(true);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
        vi.unstubAllEnvs();
        fs.rmSync(tmpDir, { recursive: true, force: true });
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
        expect(messages.some(hasScopeHeader)).toBe(false);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });

    it("does not log when preset does not exist under any sandbox load path", () => {
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
        expect(messages.some(hasScopeHeader)).toBe(false);
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
      // The binary is resolved via resolveOpenshell() so it may be an absolute
      // path; assert the openshell tail and the rest of the argv shape.
      expect(cmd[0]).toMatch(/openshell$/);
      expect(cmd.slice(1)).toEqual([
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
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-bin-"));
      const override = path.join(tmpDir, "openshell");
      fs.writeFileSync(override, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const prev = process.env.NEMOCLAW_OPENSHELL_BIN;
      process.env.NEMOCLAW_OPENSHELL_BIN = override;
      try {
        const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
        expect(cmd).toEqual([
          override,
          "policy",
          "set",
          "--policy",
          "/tmp/policy.yaml",
          "--wait",
          "my-assistant",
        ]);
      } finally {
        if (prev === undefined) delete process.env.NEMOCLAW_OPENSHELL_BIN;
        else process.env.NEMOCLAW_OPENSHELL_BIN = prev;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // Regression for issue #4224: when openshell is installed at ~/.local/bin/openshell
  // (the installer's user-local location) but PATH from a non-interactive shell does
  // not include ~/.local/bin/, buildPolicySetCommand / buildPolicyGetCommand must
  // resolve openshell to an absolute path so spawnSync does not raise ENOENT.
  describe("spawnSync openshell ENOENT in non-interactive shells (#4224)", () => {
    let tmpHome: string;
    let fakeOpenshell: string;
    let origHome: string | undefined;
    let origPath: string | undefined;
    let origBin: string | undefined;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-issue4224-"));
      const localBin = path.join(tmpHome, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      fakeOpenshell = path.join(localBin, "openshell");
      fs.writeFileSync(
        fakeOpenshell,
        "#!/bin/sh\nprintf 'version: 1\\nnetwork_policies: {}\\n'\nexit 0\n",
        { mode: 0o755 },
      );

      origHome = process.env.HOME;
      origPath = process.env.PATH;
      origBin = process.env.NEMOCLAW_OPENSHELL_BIN;
      // Simulate the non-interactive shell: openshell not on PATH, no override.
      process.env.HOME = tmpHome;
      process.env.PATH = "/nonexistent-nemoclaw-path";
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    });

    afterEach(() => {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
      if (origBin === undefined) delete process.env.NEMOCLAW_OPENSHELL_BIN;
      else process.env.NEMOCLAW_OPENSHELL_BIN = origBin;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("buildPolicySetCommand resolves openshell to ~/.local/bin/openshell when PATH lacks it", () => {
      const cmd = policies.buildPolicySetCommand("/tmp/policy.yaml", "my-assistant");
      expect(cmd[0]).toBe(fakeOpenshell);
      expect(cmd).toEqual([
        fakeOpenshell,
        "policy",
        "set",
        "--policy",
        "/tmp/policy.yaml",
        "--wait",
        "my-assistant",
      ]);
    });

    it("buildPolicyGetCommand resolves openshell to ~/.local/bin/openshell when PATH lacks it", () => {
      const cmd = policies.buildPolicyGetCommand("my-assistant");
      expect(cmd[0]).toBe(fakeOpenshell);
      expect(cmd).toEqual([fakeOpenshell, "policy", "get", "--base", "my-assistant"]);
    });

    it("assertOpenshellResolvable emits a diagnostic listing every checked location and exits nonzero when openshell cannot be resolved", () => {
      const resolveSpy = vi.spyOn(resolveOpenshellModule, "resolveOpenshell").mockReturnValue(null);
      const errors: string[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map((a) => String(a)).join(" "));
      });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
        throw new Error("__test_exit__");
      }) as never);

      process.env.HOME = tmpHome;
      process.env.PATH = "/nonexistent-nemoclaw-path";
      process.env.NEMOCLAW_OPENSHELL_BIN = "/nonexistent/openshell";

      try {
        expect(() => policies.assertOpenshellResolvable()).toThrow(/__test_exit__/);
        expect(exitSpy).toHaveBeenCalledWith(1);
        const combined = errors.join("\n");
        expect(combined).toMatch(/openshell binary not found/);
        expect(combined).toMatch(/NEMOCLAW_OPENSHELL_BIN=\/nonexistent\/openshell/);
        // PATH value should be logged verbatim so bug reports name what was searched.
        expect(combined).toContain("PATH=/nonexistent-nemoclaw-path");
        expect(combined).toContain(`${tmpHome}/.local/bin/openshell`);
        expect(combined).toContain("/usr/local/bin/openshell");
        expect(combined).toContain("/usr/bin/openshell");
        expect(combined).toMatch(/Install OpenShell|NEMOCLAW_OPENSHELL_BIN/);
      } finally {
        resolveSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it("assertOpenshellResolvable is a noop when openshell resolves", () => {
      const resolveSpy = vi
        .spyOn(resolveOpenshellModule, "resolveOpenshell")
        .mockReturnValue(fakeOpenshell);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
        throw new Error("should not exit");
      }) as never);
      try {
        expect(() => policies.assertOpenshellResolvable()).not.toThrow();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(errSpy).not.toHaveBeenCalled();
      } finally {
        resolveSpy.mockRestore();
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    // The assertion must fire BEFORE any temp dir/file creation. With a real
    // `process.exit(1)` the matching `finally` does not run, so a temp dir
    // created before the exit gets orphaned in $TMPDIR. A mocked exit (which
    // throws) doesn't reproduce that — `finally` still runs and cleans up. To
    // catch the real-world bug, spy on this process's mkdtempSync calls:
    // if the assertion fires before mkdtempSync, no nemoclaw-policy-* dir
    // should be requested.
    it("applyPreset does not create temp dirs before the openshell resolvability check", () => {
      const policyTempPrefix = path.join(os.tmpdir(), "nemoclaw-policy-");

      const resolveSpy = vi
        .spyOn(resolveOpenshellModule, "resolveOpenshell")
        .mockReturnValueOnce(fakeOpenshell)
        .mockReturnValue(null);
      const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
        throw new Error("__test_exit__");
      }) as never);

      try {
        expect(() => policies.applyPreset("my-assistant", "npm")).toThrow(/__test_exit__/);
        expect(exitSpy).toHaveBeenCalledWith(1);
        // No `nemoclaw-policy-*` temp dir should have been created before
        // the resolvability check exited.
        expect(
          mkdtempSpy.mock.calls.filter(([prefix]) => String(prefix).startsWith(policyTempPrefix)),
        ).toEqual([]);
      } finally {
        resolveSpy.mockRestore();
        mkdtempSpy.mockRestore();
        errSpy.mockRestore();
        logSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });
  });

  describe("preset apply must not overwrite a live policy that could not be read (#4586)", () => {
    const registryModule = requireForTest(
      path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"),
    ) as Record<string, any>;
    const CUSTOM = "network_policies:\n  example:\n    host: example.com\n";
    const DEGRADED =
      '#!/bin/sh\nif [ "$1" = "policy" ] && [ "$2" = "get" ]; then echo "error: gateway is restarting"; fi\nexit 0\n';

    let tmpHome: string;
    let fakeOpenshell: string;
    let origHome: string | undefined;
    let resolveSpy: ReturnType<typeof vi.spyOn>;
    let savedGetSandbox: any;
    let savedAddCustomPolicy: any;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-issue4586-"));
      const localBin = path.join(tmpHome, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      fakeOpenshell = path.join(localBin, "openshell");
      origHome = process.env.HOME;
      process.env.HOME = tmpHome;
      resolveSpy = vi
        .spyOn(resolveOpenshellModule, "resolveOpenshell")
        .mockReturnValue(fakeOpenshell);
      savedGetSandbox = registryModule.getSandbox;
      savedAddCustomPolicy = registryModule.addCustomPolicy;
      registryModule.getSandbox = (name: string) => ({ name });
      registryModule.addCustomPolicy = () => true;
    });

    afterEach(() => {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      resolveSpy.mockRestore();
      registryModule.getSandbox = savedGetSandbox;
      registryModule.addCustomPolicy = savedAddCustomPolicy;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("aborts applyPresetContent (returns false) when policy get exits 0 with degraded output", () => {
      fs.writeFileSync(fakeOpenshell, DEGRADED, { mode: 0o755 });
      const errs: string[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errs.push(a.map((x) => String(x)).join(" "));
      });
      const logs: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
        logs.push(a.map((x) => String(x)).join(" "));
      });
      try {
        const result = policies.applyPresetContent("alpha", "my-custom", CUSTOM, {
          custom: { sourcePath: "/tmp/x.yaml" },
        });
        expect(result).toBe(false);
        expect(errs.join("\n")).toMatch(/[Cc]ould not read the current policy/);
        expect(logs.join("\n")).not.toContain("Applied preset:");
      } finally {
        errSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("aborts applyPresets (returns false) when policy get exits 0 with degraded output", () => {
      fs.writeFileSync(fakeOpenshell, DEGRADED, { mode: 0o755 });
      const errs: string[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errs.push(a.map((x) => String(x)).join(" "));
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const result = policies.applyPresets("alpha", ["npm"]);
        expect(result).toBe(false);
        expect(errs.join("\n")).toMatch(/[Cc]ould not read the current policy/);
      } finally {
        errSpy.mockRestore();
        logSpy.mockRestore();
      }
    });
  });

  describe("policy-add --from-file false success when the sandbox is absent from the registry (#4510)", () => {
    const registryModule = requireForTest(
      path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"),
    ) as Record<string, any>;
    const CUSTOM_CONTENT = "network_policies:\n  slack-files-upload:\n    host: files.slack.com\n";
    const SOURCE_PATH = "/tmp/slack-files-upload-case.yaml";

    let tmpHome: string;
    let fakeOpenshell: string;
    let origHome: string | undefined;
    let resolveSpy: ReturnType<typeof vi.spyOn>;
    let savedGetSandbox: any;
    let savedAddCustomPolicy: any;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-issue4510-"));
      const localBin = path.join(tmpHome, ".local", "bin");
      fs.mkdirSync(localBin, { recursive: true });
      fakeOpenshell = path.join(localBin, "openshell");
      fs.writeFileSync(
        fakeOpenshell,
        "#!/bin/sh\nprintf 'version: 1\\nnetwork_policies: {}\\n'\nexit 0\n",
        { mode: 0o755 },
      );
      origHome = process.env.HOME;
      process.env.HOME = tmpHome;
      resolveSpy = vi
        .spyOn(resolveOpenshellModule, "resolveOpenshell")
        .mockReturnValue(fakeOpenshell);
      savedGetSandbox = registryModule.getSandbox;
      savedAddCustomPolicy = registryModule.addCustomPolicy;
    });

    afterEach(() => {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      resolveSpy.mockRestore();
      registryModule.getSandbox = savedGetSandbox;
      registryModule.addCustomPolicy = savedAddCustomPolicy;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("returns false and warns when a custom preset cannot be recorded locally", () => {
      // Sandbox is Ready on the gateway but missing from the local registry
      // (e.g. after stale-registry pruning), so addCustomPolicy cannot persist.
      registryModule.getSandbox = () => null;
      const addSpy = vi.fn(() => false);
      registryModule.addCustomPolicy = addSpy;
      const errors: string[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errors.push(a.map((x) => String(x)).join(" "));
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const result = policies.applyPresetContent(
          "my-assistant",
          "slack-files-upload",
          CUSTOM_CONTENT,
          { custom: { sourcePath: SOURCE_PATH } },
        );
        // Pre-fix this returned true (silent exit 0) while policy-list/status
        // never showed the preset. The command must not claim success.
        expect(result).toBe(false);
        expect(addSpy).not.toHaveBeenCalled();
        const combined = errors.join("\n");
        expect(combined).toContain("my-assistant");
        expect(combined).toMatch(/could not be\s+recorded locally/);
        expect(combined).toMatch(/policy-list or status/);
      } finally {
        errSpy.mockRestore();
        logSpy.mockRestore();
      }
    });

    it("records the custom preset and returns true when the sandbox is registered", () => {
      registryModule.getSandbox = (name: string) => ({ name });
      const addSpy = vi.fn(() => true);
      registryModule.addCustomPolicy = addSpy;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const result = policies.applyPresetContent(
          "my-assistant",
          "slack-files-upload",
          CUSTOM_CONTENT,
          { custom: { sourcePath: SOURCE_PATH } },
        );
        expect(result).toBe(true);
        expect(addSpy).toHaveBeenCalledWith(
          "my-assistant",
          expect.objectContaining({
            name: "slack-files-upload",
            content: CUSTOM_CONTENT,
            sourcePath: SOURCE_PATH,
          }),
        );
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
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
    const sampleEntries = "  example:\n    endpoints:\n      - host: example.com";

    it("refuses an unmarked current mapping without a policy root", () => {
      const versionless = "some_key:\n  foo: bar";
      expect(() => policies.mergePresetIntoPolicy(versionless, sampleEntries)).toThrow(
        /current policy is not a valid YAML mapping/,
      );
    });

    it("appends preset entries when current policy has network_policies but no version", () => {
      const versionlessWithNp = "network_policies:\n  existing:\n    host: existing.com";
      const merged = policies.mergePresetIntoPolicy(versionlessWithNp, sampleEntries);
      expect(merged).toContain("version:");
      expect(merged).toContain("existing.com");
      expect(merged).toContain("example.com");
    });

    it("keeps existing version when present", () => {
      const withVersion = "version: 2\nnetwork_policies:\n  old:\n    host: old.com";
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

    it("fails closed when the current policy read is truncated", () => {
      expect(() =>
        policies.mergePresetIntoPolicy("Version: 3\nHash: abc123", sampleEntries),
      ).toThrow(/Cannot merge policy preset: the current policy is not a valid YAML mapping/);
    });

    it("fails closed when preset entries are malformed or not a mapping", () => {
      for (const invalidEntries of ["  broken: [unterminated", "  - host: example.com"]) {
        expect(() => policies.mergePresetIntoPolicy("version: 1", invalidEntries)).toThrow(
          /preset network_policies entries must be a valid YAML mapping/,
        );
      }
    });

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

  describe("mergePresetNamesIntoPolicy", () => {
    it("merges built-in named presets into policy content", () => {
      const current =
        "version: 1\n\n" +
        "network_policies:\n" +
        "  existing:\n" +
        "    name: existing\n" +
        "    endpoints:\n" +
        "      - host: api.example.com\n" +
        "        port: 443\n" +
        "        access: full\n";

      const result = policies.mergePresetNamesIntoPolicy(current, ["slack"]);

      expect(result.appliedPresets).toEqual(["slack"]);
      expect(result.missingPresets).toEqual([]);
      expect(result.policy).toContain("existing");
      expect(result.policy).toContain("slack:");
      expect(result.policy).toContain("wss-primary.slack.com");
    });
  });

  describe("selectFromList", () => {
    it("returns preset name by number from stdin input", async () => {
      const result = await runSelectionPrompt("selectFromList", "1\n");

      expect(result.selected).toBe("npm");
      expect(result.stderr).toContain("Choose preset [1]:");
    });

    it("uses the first preset as the default when input is empty", async () => {
      const result = await runSelectionPrompt("selectFromList", "\n");

      expect(result.stderr).toContain("Choose preset [1]:");
      expect(result.selected).toBe("npm");
    });

    it("defaults to the first not-applied preset", async () => {
      const result = await runSelectionPrompt("selectFromList", "\n", { applied: ["npm"] });

      expect(result.stderr).toContain("Choose preset [2]:");
      expect(result.selected).toBe("pypi");
    });

    it("rejects selecting an already-applied preset", async () => {
      const result = await runSelectionPrompt("selectFromList", "1\n", { applied: ["npm"] });

      expect(result.stderr).toMatch(/already applied\.[\s\S]*policy-add npm'/);
      expect(result.selected).toBeNull();
    });

    it("rejects out-of-range preset number", async () => {
      const result = await runSelectionPrompt("selectFromList", "99\n");

      expect(result.stderr).toContain("Invalid preset number.");
      expect(result.selected).toBeNull();
    });

    it("rejects non-numeric preset input", async () => {
      const result = await runSelectionPrompt("selectFromList", "npm\n");

      expect(result.stderr).toContain("Invalid preset number.");
      expect(result.selected).toBeNull();
    });

    it("prints numbered list with applied markers, legend, and default prompt", async () => {
      const result = await runSelectionPrompt("selectFromList", "2\n", { applied: ["npm"] });

      expect(result.stderr).toMatch(/Available presets:/);
      expect(result.stderr).toMatch(/1\) ● npm — npm and Yarn registry access/);
      expect(result.stderr).toMatch(/2\) ○ pypi — Python Package Index \(PyPI\) access/);
      expect(result.stderr).toMatch(/● applied, ○ not applied/);
      expect(result.stderr).toMatch(/Choose preset \[2\]:/);
      expect(result.selected).toBe("pypi");
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

    it("rejects removal when network_policies is a legacy array", () => {
      const current = "version: 1\n\nnetwork_policies:\n  - host: pypi.org\n    allow: true\n";
      expect(() => policies.removePresetFromPolicy(current, pypiEntries)).toThrow(
        /current policy is not a valid YAML mapping/i,
      );
    });
  });

  describe("selectForRemoval", () => {
    it("returns null when no presets are applied", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "1\n", { applied: [] });
      expect(result.stderr).toContain("No presets are currently applied");
      expect(result.selected).toBeNull();
    });

    it("shows only applied presets and returns selected name", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "1\n", { applied: ["npm"] });
      expect(result.stderr).toContain("Applied presets:");
      expect(result.stderr).toContain("1) npm");
      expect(result.stderr).not.toContain("pypi");
      expect(result.selected).toBe("npm");
    });

    it("returns null for empty input", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "\n", { applied: ["npm"] });
      expect(result.selected).toBeNull();
    });

    it("rejects non-numeric input", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "npm\n", {
        applied: ["npm"],
      });
      expect(result.stderr).toContain("Invalid preset number");
      expect(result.selected).toBeNull();
    });

    it("rejects out-of-range number", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "99\n", { applied: ["npm"] });
      expect(result.stderr).toContain("Invalid preset number");
      expect(result.selected).toBeNull();
    });

    it("selects second preset when both are applied", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "2\n", {
        applied: ["npm", "pypi"],
      });
      expect(result.stderr).toContain("1) npm");
      expect(result.stderr).toContain("2) pypi");
      expect(result.selected).toBe("pypi");
    });
  });

  describe("loadPresetFromFile", () => {
    const tmpDirs: string[] = [];
    afterEach(() => {
      while (tmpDirs.length > 0) {
        const dir = tmpDirs.pop();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    function writeTmp(body: string, ext = "yaml") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preset-"));
      tmpDirs.push(dir);
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

    it("rejects files exceeding the size limit before reading", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-preset-"));
      tmpDirs.push(dir);
      const file = path.join(dir, "huge.yaml");
      const padding = "# ".repeat(5_500_000);
      fs.writeFileSync(
        file,
        `preset:\n  name: huge\nnetwork_policies:\n  r:\n    name: r\n${padding}`,
      );
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(file)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(msgs.some((m) => typeof m === "string" && m.includes("too large"))).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });

    it("rejects symbolic links to a preset file", () => {
      const body = "preset:\n  name: link-target\nnetwork_policies:\n  r:\n    name: r\n";
      const { dir, file } = writeTmp(body);
      const linkPath = path.join(dir, "link.yaml");
      fs.symlinkSync(file, linkPath);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(policies.loadPresetFromFile(linkPath)).toBe(null);
        const msgs = errSpy.mock.calls.map((c) => c[0]);
        expect(
          msgs.some((m) => typeof m === "string" && m.includes("must not be a symbolic link")),
        ).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe("interactive prompt cleanup", () => {
    it("releases and re-refs stdin around policy-add preset prompts", async () => {
      const result = await runSelectionPrompt("selectFromList", "1\n");
      expect(result.selected).toBe("npm");
      expect(result.counts.ref).toBeGreaterThanOrEqual(1);
      expect(result.counts.pause).toBeGreaterThanOrEqual(1);
      expect(result.counts.unref).toBeGreaterThanOrEqual(1);
      expect(result.close).toHaveBeenCalledOnce();
    });

    it("releases and re-refs stdin around policy-remove preset prompts", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "1\n", { applied: ["npm"] });
      expect(result.selected).toBe("npm");
      expect(result.counts.ref).toBeGreaterThanOrEqual(1);
      expect(result.counts.pause).toBeGreaterThanOrEqual(1);
      expect(result.counts.unref).toBeGreaterThanOrEqual(1);
      expect(result.close).toHaveBeenCalledOnce();
    });
  });
});
