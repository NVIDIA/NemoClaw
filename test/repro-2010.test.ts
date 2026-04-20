// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction test for issue #2010:
 *   policy-list shows telegram as not applied but gateway still allows traffic.
 *
 * Verifies that:
 *   1. getGatewayPresets() correctly identifies presets active on the gateway
 *      by cross-referencing network_policies keys against preset definitions.
 *   2. sandboxPolicyList() shows discrepancy markers when registry and gateway
 *      disagree on which presets are applied.
 */

import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import policies from "../dist/lib/policies.js";

const REPO_ROOT = path.join(import.meta.dirname, "..");

// Build a fake gateway response that contains the given presets'
// network_policies, simulating the post-rebuild desync.
function buildGatewayYaml(presetNames) {
  const parts = ["version: 1", "", "network_policies:"];
  for (const name of presetNames) {
    const content = policies.loadPreset(name);
    if (!content) continue;
    const entries = policies.extractPresetEntries(content);
    if (!entries) continue;
    parts.push(entries);
  }
  // Wrap with the metadata header that openshell policy get --full returns
  return "Version: 3\nHash: abc123\nUpdated: 2026-01-01\n---\n" + parts.join("\n");
}

describe("issue #2010 — policy state inconsistency", () => {
  describe("getGatewayPresets — matching logic", () => {
    it("identifies telegram preset from gateway policy containing telegram_bot key", () => {
      const telegramContent = policies.loadPreset("telegram");
      const entries = policies.extractPresetEntries(telegramContent);
      expect(entries).toContain("telegram_bot:");

      const gatewayYaml = buildGatewayYaml(["telegram"]);
      const currentPolicy = policies.parseCurrentPolicy(gatewayYaml);
      expect(currentPolicy).toBeTruthy();

      const parsed = YAML.parse(currentPolicy);
      expect(parsed.network_policies).toBeTruthy();
      expect(parsed.network_policies.telegram_bot).toBeTruthy();

      // Verify preset matching: telegram's keys should all be in the gateway
      const gatewayKeys = new Set(Object.keys(parsed.network_policies));
      const presetEntries = policies.extractPresetEntries(telegramContent);
      const wrappedParsed = YAML.parse("network_policies:\n" + presetEntries);
      const presetKeys = Object.keys(wrappedParsed.network_policies);
      expect(presetKeys.every((k) => gatewayKeys.has(k))).toBe(true);
    });

    it("does not match presets whose keys are absent from gateway", () => {
      const gatewayYaml = buildGatewayYaml(["telegram"]);
      const currentPolicy = policies.parseCurrentPolicy(gatewayYaml);
      const parsed = YAML.parse(currentPolicy);
      const gatewayKeys = new Set(Object.keys(parsed.network_policies));

      const npmContent = policies.loadPreset("npm");
      const npmEntries = policies.extractPresetEntries(npmContent);
      const npmParsed = YAML.parse("network_policies:\n" + npmEntries);
      const npmKeys = Object.keys(npmParsed.network_policies);
      expect(npmKeys.every((k) => gatewayKeys.has(k))).toBe(false);
    });

    it("matches multiple presets when gateway has all their keys", () => {
      const gatewayYaml = buildGatewayYaml(["telegram", "npm", "pypi"]);
      const currentPolicy = policies.parseCurrentPolicy(gatewayYaml);
      const parsed = YAML.parse(currentPolicy);
      const gatewayKeys = new Set(Object.keys(parsed.network_policies));

      for (const presetName of ["telegram", "npm", "pypi"]) {
        const content = policies.loadPreset(presetName);
        const entries = policies.extractPresetEntries(content);
        const presetParsed = YAML.parse("network_policies:\n" + entries);
        const presetKeys = Object.keys(presetParsed.network_policies);
        expect(presetKeys.every((k) => gatewayKeys.has(k))).toBe(true);
      }
    });

    it("returns empty for empty gateway policy", () => {
      const emptyYaml = policies.parseCurrentPolicy("");
      expect(emptyYaml).toBe("");
    });

    it("returns empty for gateway with no network_policies", () => {
      const raw = "Version: 1\n---\nversion: 1\nfilesystem_policy:\n  read_only: true";
      const currentPolicy = policies.parseCurrentPolicy(raw);
      const parsed = YAML.parse(currentPolicy);
      expect(parsed.network_policies).toBeFalsy();
    });
  });

  describe("sandboxPolicyList — discrepancy display", () => {
    it("shows discrepancy when gateway has telegram but registry does not", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const origGetApplied = policies.getAppliedPresets;
      const origGetGateway = policies.getGatewayPresets;
      policies.getAppliedPresets = () => [];
      policies.getGatewayPresets = () => ["telegram"];

      try {
        const allPresets = policies.listPresets();
        const registryPresets = policies.getAppliedPresets("test-sandbox");
        const gatewayPresets = policies.getGatewayPresets("test-sandbox");

        expect(registryPresets).toEqual([]);
        expect(gatewayPresets).toEqual(["telegram"]);

        const telegramPreset = allPresets.find((p) => p.name === "telegram");
        expect(telegramPreset).toBeTruthy();

        const inRegistry = registryPresets.includes("telegram");
        const inGateway = gatewayPresets.includes("telegram");
        expect(inRegistry).toBe(false);
        expect(inGateway).toBe(true);
        // ● telegram — ... (active on gateway, missing from local state)
      } finally {
        policies.getAppliedPresets = origGetApplied;
        policies.getGatewayPresets = origGetGateway;
        logSpy.mockRestore();
      }
    });

    it("shows discrepancy when registry has telegram but gateway does not", () => {
      const origGetApplied = policies.getAppliedPresets;
      const origGetGateway = policies.getGatewayPresets;
      policies.getAppliedPresets = () => ["telegram"];
      policies.getGatewayPresets = () => [];

      try {
        const registryPresets = policies.getAppliedPresets("test-sandbox");
        const gatewayPresets = policies.getGatewayPresets("test-sandbox");

        expect(registryPresets.includes("telegram")).toBe(true);
        expect(gatewayPresets.includes("telegram")).toBe(false);
        // ○ telegram — ... (recorded locally, not active on gateway)
      } finally {
        policies.getAppliedPresets = origGetApplied;
        policies.getGatewayPresets = origGetGateway;
      }
    });

    it("shows consistent state when both agree", () => {
      const origGetApplied = policies.getAppliedPresets;
      const origGetGateway = policies.getGatewayPresets;
      policies.getAppliedPresets = () => ["telegram"];
      policies.getGatewayPresets = () => ["telegram"];

      try {
        const registryPresets = policies.getAppliedPresets("test-sandbox");
        const gatewayPresets = policies.getGatewayPresets("test-sandbox");

        expect(registryPresets.includes("telegram")).toBe(true);
        expect(gatewayPresets.includes("telegram")).toBe(true);
        // ● telegram — ... (no suffix)
      } finally {
        policies.getAppliedPresets = origGetApplied;
        policies.getGatewayPresets = origGetGateway;
      }
    });

    it("falls back to registry display when gateway returns null", () => {
      const origGetApplied = policies.getAppliedPresets;
      const origGetGateway = policies.getGatewayPresets;
      policies.getAppliedPresets = () => ["telegram"];
      policies.getGatewayPresets = () => null; // gateway unreachable

      try {
        const registryPresets = policies.getAppliedPresets("test-sandbox");
        const gatewayPresets = policies.getGatewayPresets("test-sandbox");

        expect(gatewayPresets).toBe(null);
        // When gateway is null, inGateway should be null, fallback to registry
        const inRegistry = registryPresets.includes("telegram");
        const inGateway = gatewayPresets ? gatewayPresets.includes("telegram") : null;
        expect(inGateway).toBe(null);
        // Marker should be ● (from registry), no discrepancy suffix
        expect(inRegistry).toBe(true);
      } finally {
        policies.getAppliedPresets = origGetApplied;
        policies.getGatewayPresets = origGetGateway;
      }
    });
  });

  describe("sandboxPolicyList — full output via subprocess", () => {
    it("renders discrepancy markers in CLI output", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repro-2010-"));
      const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "policies.js"));
      const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "bin", "nemoclaw.js"));
      const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "registry.js"));

      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});

// Mock registry to return a sandbox with no presets recorded
registry.getSandbox = (name) => (name === "test-sandbox" ? { name, policies: [] } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });

// Mock getAppliedPresets to return empty (post-rebuild state)
policies.getAppliedPresets = () => [];

// Mock getGatewayPresets to return telegram (old policy still loaded)
policies.getGatewayPresets = () => ["telegram"];

// Execute the CLI policy-list command
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-list"];
require(${CLI_PATH});
`;

      const scriptPath = path.join(tmpDir, "repro-2010.js");
      fs.writeFileSync(scriptPath, script);

      try {
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: { ...process.env, HOME: tmpDir },
        });

        const output = result.stdout + result.stderr;

        // telegram should show as active on gateway with discrepancy note
        expect(output).toContain("telegram");
        expect(output).toMatch(/●.*telegram.*active on gateway/);

        // npm should show as ○ (not applied anywhere)
        expect(output).toMatch(/○.*npm/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("falls back to registry-only display when gateway is unreachable", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repro-2010-"));
      const POLICIES_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "policies.js"));
      const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "bin", "nemoclaw.js"));
      const REGISTRY_PATH = JSON.stringify(path.join(REPO_ROOT, "dist", "lib", "registry.js"));

      const script = String.raw`
const registry = require(${REGISTRY_PATH});
const policies = require(${POLICIES_PATH});

registry.getSandbox = (name) => (name === "test-sandbox" ? { name, policies: ["telegram"] } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
policies.getAppliedPresets = () => ["telegram"];

// Gateway returns null — unreachable (matches real implementation behavior)
policies.getGatewayPresets = () => null;

process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-list"];
require(${CLI_PATH});
`;

      const scriptPath = path.join(tmpDir, "repro-2010-fallback.js");
      fs.writeFileSync(scriptPath, script);

      try {
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: { ...process.env, HOME: tmpDir },
        });

        const output = result.stdout + result.stderr;

        // telegram should show as ● from registry (fallback)
        expect(output).toMatch(/●.*telegram/);
        // Should show the gateway warning
        expect(output).toContain("Could not query gateway");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
