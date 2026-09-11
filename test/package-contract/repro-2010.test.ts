// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduction test for issue #2010:
 *   policy-list shows telegram as not applied but gateway still allows traffic.
 *
 * Tests getGatewayPresets() matching logic and sandboxPolicyList() discrepancy
 * rendering through the compiled package, with the OpenShell capture seam
 * installed before the policy module loads.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const POLICIES_PATH = path.join(REPO_ROOT, "dist", "lib", "policy", "index.js");
const CAPTURE_PATH = path.join(
  REPO_ROOT,
  "dist",
  "lib",
  "adapters",
  "openshell",
  "sanitized-capture.js",
);
const CLI_PATH = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const REGISTRY_PATH = path.join(REPO_ROOT, "dist", "lib", "state", "registry.js");

/**
 * Run a CJS script in a subprocess and return stdout.
 * Install optional dependency seams before loading the compiled policy module.
 */
function runScript(
  body: string,
  setup = "",
): { stdout: string; stderr: string; status: number | null } {
  const preamble = `
    ${setup}
    const policies = require(${JSON.stringify(POLICIES_PATH)});
  `;
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      preamble +
        "\n(async () => {\n" +
        body +
        "\n})().catch(error => { console.error(error); process.exitCode = 1; });",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    },
  );
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
      const content = await policies.loadPresetForSandbox("repro-2010-sandbox", name);
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
 * Build a fake gateway YAML that includes both built-in presets and the
 * given custom preset entries — used to assert custom preset matching. (#3590)
 */
function buildGatewayYamlWithCustom(
  presetNames: string[],
  customPresets: Array<{ name: string; content: string }>,
): string {
  const names = JSON.stringify(presetNames);
  const custom = JSON.stringify(customPresets);
  const { stdout } = runScript(`
    const parts = ["version: 1", "", "network_policies:"];
    for (const name of ${names}) {
      const content = await policies.loadPresetForSandbox("repro-2010-sandbox", name);
      if (!content) continue;
      const entries = policies.extractPresetEntries(content);
      if (!entries) continue;
      parts.push(entries);
    }
    for (const c of ${custom}) {
      const entries = policies.extractPresetEntries(c.content);
      if (!entries) continue;
      parts.push(entries);
    }
    process.stdout.write("Version: 3\\nHash: abc123\\nUpdated: 2026-01-01\\n---\\n" + parts.join("\\n"));
  `);
  return stdout;
}

/** Call the compiled gateway reader with an asynchronous capture fixture. */
function callGetGatewayPresets(gatewayYaml: string | null): string[] | null {
  const setup = `
    const yaml = ${JSON.stringify(gatewayYaml)};
    const capture = require(${JSON.stringify(CAPTURE_PATH)});
    capture.captureSanitizedResolvedOpenshellAsync = async () =>
      yaml === null ? { status: 1, output: "gateway unreachable" } : { status: 0, output: yaml };
    const registry = require(${JSON.stringify(REGISTRY_PATH)});
    registry.getSandbox = () => ({ name: "repro-2010-sandbox", gatewayName: "nemoclaw" });
  `;
  const result = runScript(
    `
    process.stdout.write(JSON.stringify(await policies.getGatewayPresets("repro-2010-sandbox")));
  `,
    setup,
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim());
}

describe("policy state inconsistency (#2010)", () => {
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

    it("includes a custom preset whose network_policies are enforced on the gateway (#3590)", () => {
      const custom = [
        {
          name: "slack-files-upload",
          content: `preset:
  name: slack-files-upload
  description: "Slack file upload URL access"

network_policies:
  nemoclaw_custom__slack-files-upload__slack-files-upload:
    name: slack-files-upload
    endpoints:
      - host: files.slack.com
        port: 443
        protocol: rest
        enforcement: enforce
        tls: terminate
        rules:
          - allow: { method: POST, path: "/upload/**" }
`,
        },
      ];
      const yaml = buildGatewayYamlWithCustom(["telegram"], custom);
      const result = callGetGatewayPresets(yaml);
      expect(result).toContain("telegram");
      expect(result).toContain("slack-files-upload");
    });
  });

  describe("sandboxPolicyList — CLI output via subprocess", () => {
    function runPolicyList(opts: {
      registryPresets: string[];
      gatewayPresets: string[] | null;
    }): string {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repro-2010-"));
      const script = `
const registry = require(${JSON.stringify(REGISTRY_PATH)});
const policies = require(${JSON.stringify(POLICIES_PATH)});
const registryPresets = JSON.parse(process.env.TEST_REGISTRY_PRESETS || "[]");
const gatewayPresets = process.env.TEST_GATEWAY_PRESETS ? JSON.parse(process.env.TEST_GATEWAY_PRESETS) : null;
registry.getSandbox = (name) => (name === "test-sandbox" ? { name, policies: registryPresets } : null);
registry.listSandboxes = () => ({ sandboxes: [{ name: "test-sandbox" }] });
policies.getAppliedPresets = () => registryPresets;
policies.getGatewayPresets = () => gatewayPresets;
process.argv = ["node", "nemoclaw.js", "test-sandbox", "policy-list"];
require(${JSON.stringify(CLI_PATH)});
`;
      const scriptPath = path.join(tmpDir, "repro.js");
      fs.writeFileSync(scriptPath, script);
      // policy-list now preflights `docker info` to classify a Docker daemon
      // outage (#4428); stub a healthy daemon so the gateway-unreachable
      // fallback path stays hermetic on Dockerless/Docker-stopped runners.
      const binDir = path.join(tmpDir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, "docker"),
        [
          "#!/usr/bin/env bash",
          'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      try {
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: tmpDir,
            PATH: `${binDir}:${process.env.PATH || ""}`,
            TEST_GATEWAY_PRESETS:
              opts.gatewayPresets === null ? "" : JSON.stringify(opts.gatewayPresets),
            TEST_REGISTRY_PRESETS: JSON.stringify(opts.registryPresets),
          },
        });
        return (result.stdout || "") + (result.stderr || "");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    it("shows the live OpenShell preset without a registry-desync suffix", () => {
      const output = runPolicyList({ registryPresets: [], gatewayPresets: ["telegram"] });
      expect(output).toMatch(/●.*telegram.*user-added/);
      expect(output).toMatch(/○.*npm/);
    });

    it("ignores a legacy registry-only preset", () => {
      const output = runPolicyList({ registryPresets: ["telegram"], gatewayPresets: [] });
      expect(output).toMatch(/○.*telegram/);
      expect(output).not.toContain("recorded locally");
    });

    it("shows ● with no suffix when both sources agree", () => {
      const output = runPolicyList({ registryPresets: ["telegram"], gatewayPresets: ["telegram"] });
      expect(output).toMatch(/●.*telegram/);
      expect(output).not.toContain("active on gateway");
      expect(output).not.toContain("recorded locally");
    });

    it("does not fall back to registry policy state when OpenShell is unreachable", () => {
      const output = runPolicyList({ registryPresets: ["telegram"], gatewayPresets: null });
      expect(output).toMatch(/○.*telegram/);
      expect(output).toContain("Could not query OpenShell");
      expect(output).not.toContain("local state only");
    });
  });
});
