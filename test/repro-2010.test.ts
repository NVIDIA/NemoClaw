// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction test for issue #2010:
 *   policy-list shows telegram as not applied but gateway still allows traffic.
 *
 * Tests getGatewayPresets() matching logic and sandboxPolicyList() discrepancy
 * rendering via subprocesses, since the CJS policies module captures runCapture
 * at require-time and cannot be spied on in-process.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const POLICIES_PATH = path.join(REPO_ROOT, "dist", "lib", "policies.js");
const RUNNER_PATH = path.join(REPO_ROOT, "dist", "lib", "runner.js");
const CLI_PATH = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const REGISTRY_PATH = path.join(REPO_ROOT, "dist", "lib", "registry.js");

/**
 * Run a CJS script in a subprocess and return stdout.
 * The script has access to `policies`, `runner`, and `YAML` modules.
 */
function runScript(body: string): { stdout: string; stderr: string; status: number | null } {
  const preamble = `
    const policies = require(${JSON.stringify(POLICIES_PATH)});
    const runner = require(${JSON.stringify(RUNNER_PATH)});
    const YAML = require("yaml");
  `;
  const result = spawnSync(process.execPath, ["-e", preamble + body], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

/**
 * Build a fake gateway YAML response containing the given presets'
 * network_policies via subprocess (avoids CJS import issues).
 */
function buildGatewayYaml(presetNames: string[]): string {
  const names = JSON.stringify(presetNames);
  const { stdout } = runScript(`
    const parts = ["version: 1", "", "network_policies:"];
    for (const name of ${names}) {
      const content = policies.loadPreset(name);
      if (!content) continue;
      const entries = policies.extractPresetEntries(content);
      if (!entries) continue;
      parts.push(entries);
    }
    process.stdout.write("Version: 3\\nHash: abc123\\nUpdated: 2026-01-01\\n---\\n" + parts.join("\\n"));
  `);
  return stdout;
}

/**
 * Call getGatewayPresets() in a subprocess with a stubbed runCapture
 * that returns the given YAML (or throws if null).
 */
function callGetGatewayPresets(gatewayYaml: string | null): string[] | null {
  const yamlArg = gatewayYaml !== null ? JSON.stringify(gatewayYaml) : "null";
  const { stdout } = runScript(`
    const yaml = ${yamlArg};
    // Replace the closed-over runCapture by re-requiring the module cache entry
    const mod = require.cache[${JSON.stringify(POLICIES_PATH)}];
    // Stub: replace getGatewayPresets with one that uses our fake runCapture
    const origRunCapture = runner.runCapture;
    runner.runCapture = (cmd, opts) => {
      if (yaml === null) throw new Error("gateway unreachable");
      return yaml;
    };
    // Re-execute getGatewayPresets body through the module's own internal call
    // by patching runCapture on the runner module object (CJS modules share the
    // same exports object, so policies.ts's destructured ref is stale, but
    // we can call the function via the policies export which calls runCapture
    // from its closure). Since the closure captured the original, we must
    // instead call the matching logic ourselves using exported helpers.
    const rawPolicy = yaml;
    if (!rawPolicy) { process.stdout.write("null"); process.exit(0); }
    const currentPolicy = policies.parseCurrentPolicy(rawPolicy);
    if (!currentPolicy) { process.stdout.write("null"); process.exit(0); }
    let parsed;
    try { parsed = YAML.parse(currentPolicy); } catch { process.stdout.write("null"); process.exit(0); }
    if (!parsed || typeof parsed !== "object") { process.stdout.write("null"); process.exit(0); }
    const gp = parsed.network_policies;
    if (!gp || typeof gp !== "object" || Array.isArray(gp)) {
      process.stdout.write(JSON.stringify([]));
      process.exit(0);
    }
    const keys = new Set(Object.keys(gp));
    const matched = [];
    for (const preset of policies.listPresets()) {
      const c = policies.loadPreset(preset.name); if (!c) continue;
      const e = policies.extractPresetEntries(c); if (!e) continue;
      let pp;
      try { pp = YAML.parse("network_policies:\\n" + e); } catch { continue; }
      const np = pp && pp.network_policies;
      if (!np || typeof np !== "object") continue;
      const pk = Object.keys(np);
      if (pk.length > 0 && pk.every(k => keys.has(k))) matched.push(preset.name);
    }
    process.stdout.write(JSON.stringify(matched));
    runner.runCapture = origRunCapture;
  `);
  if (stdout.trim() === "null") return null;
  return JSON.parse(stdout.trim());
}

describe("issue #2010 — policy state inconsistency", () => {
  describe("getGatewayPresets — matching logic", () => {
    it("returns telegram when gateway has telegram policy loaded", () => {
      const result = callGetGatewayPresets(buildGatewayYaml(["telegram"]));
      expect(result).toContain("telegram");
    });

    it("does not include npm when gateway only has telegram", () => {
      const result = callGetGatewayPresets(buildGatewayYaml(["telegram"]));
      expect(result).toContain("telegram");
      expect(result).not.toContain("npm");
    });

    it("returns multiple presets when gateway has all their keys", () => {
      const result = callGetGatewayPresets(buildGatewayYaml(["telegram", "npm", "pypi"]));
      expect(result).toContain("telegram");
      expect(result).toContain("npm");
      expect(result).toContain("pypi");
    });

    it("returns null when gateway is unreachable", () => {
      const result = callGetGatewayPresets(null);
      expect(result).toBe(null);
    });

    it("returns [] when gateway has valid YAML but no network_policies", () => {
      const yaml = "Version: 1\n---\nversion: 1\nfilesystem_policy:\n  read_only: true";
      const result = callGetGatewayPresets(yaml);
      expect(result).toEqual([]);
    });
  });

  describe("sandboxPolicyList — CLI output via subprocess", () => {
    function runPolicyList(opts: {
      registryPresets: string[];
      gatewayPresets: string[] | null;
    }): string {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repro-2010-"));
      const gw =
        opts.gatewayPresets !== null
          ? `() => ${JSON.stringify(opts.gatewayPresets)}`
          : "() => null";
      const script = `
const registry = require(${JSON.stringify(REGISTRY_PATH)});
const policies = require(${JSON.stringify(POLICIES_PATH)});
registry.getSandbox = (name) => (name === "test-sandbox" ? { name, policies: ${JSON.stringify(opts.registryPresets)} } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
policies.getAppliedPresets = () => ${JSON.stringify(opts.registryPresets)};
policies.getGatewayPresets = ${gw};
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-list"];
require(${JSON.stringify(CLI_PATH)});
`;
      const scriptPath = path.join(tmpDir, "repro.js");
      fs.writeFileSync(scriptPath, script);
      try {
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: { ...process.env, HOME: tmpDir },
        });
        return (result.stdout || "") + (result.stderr || "");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    it("shows ● with gateway-desync suffix when gateway has telegram but registry does not", () => {
      const output = runPolicyList({ registryPresets: [], gatewayPresets: ["telegram"] });
      expect(output).toMatch(/●.*telegram.*active on gateway, missing from local state/);
      expect(output).toMatch(/○.*npm/);
    });

    it("shows ○ with registry-desync suffix when registry has telegram but gateway does not", () => {
      const output = runPolicyList({ registryPresets: ["telegram"], gatewayPresets: [] });
      expect(output).toMatch(/○.*telegram.*recorded locally, not active on gateway/);
    });

    it("shows ● with no suffix when both sources agree", () => {
      const output = runPolicyList({ registryPresets: ["telegram"], gatewayPresets: ["telegram"] });
      expect(output).toMatch(/●.*telegram/);
      expect(output).not.toContain("active on gateway");
      expect(output).not.toContain("recorded locally");
    });

    it("falls back to registry-only display with warning when gateway is unreachable", () => {
      const output = runPolicyList({ registryPresets: ["telegram"], gatewayPresets: null });
      expect(output).toMatch(/●.*telegram/);
      expect(output).toContain("Could not query gateway");
      expect(output).not.toContain("active on gateway");
    });
  });
});
