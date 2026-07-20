// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { LIVE_E2E_ROOT, REPO_ROOT } from "../fixtures/paths.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const SPECIAL_GATE_ENV = [
  "NEMOCLAW_E2E_CONNECT_RLIMITS",
  "NEMOCLAW_ISSUE_4434_LIVE",
  "NEMOCLAW_MCP_BRIDGE_AGENT",
] as const;

function liveTestFiles(root = LIVE_E2E_ROOT): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    return entry.isDirectory()
      ? liveTestFiles(candidate)
      : entry.isFile() && entry.name.endsWith(".test.ts")
        ? [candidate]
        : [];
  });
}

function listLiveTests(options: {
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
  files?: readonly string[];
  filesOnly?: boolean;
}) {
  const args = [
    "list",
    "--project",
    "e2e-live",
    ...(options.files ?? []).map((file) => `test/e2e/live/${file}`),
    ...(options.filesOnly ? ["--filesOnly"] : []),
    "--passWithNoTests",
  ];

  const result = spawnSync(process.execPath, [VITEST, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_RUN_LIVE_E2E: options.enabled ? "1" : undefined,
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: undefined,
      NEMOCLAW_PROVIDER: "nvidia",
      ...Object.fromEntries(SPECIAL_GATE_ENV.map((name) => [name, undefined])),
      ...options.env,
    },
    timeout: 30_000,
  });
  return {
    ...result,
    lines: result.stdout.split(/\r?\n/).filter((line) => line.startsWith("[e2e-live] ")),
  };
}

function linesForFile(lines: readonly string[], file: string): string[] {
  return lines.filter((line) => line.startsWith(`[e2e-live] test/e2e/live/${file} >`));
}

describe("live E2E target gating", () => {
  it("collects the bootstrap install test through the trusted-main legacy path", () => {
    const legacy = listLiveTests({
      enabled: true,
      env: { E2E_TARGET_ID: "launchable-smoke" },
      files: ["launchable-smoke.test.ts"],
    });

    expect(legacy.status, legacy.stderr || legacy.stdout).toBe(0);
    expect(linesForFile(legacy.lines, "launchable-smoke.test.ts")).toEqual([
      "[e2e-live] test/e2e/live/launchable-smoke.test.ts > bootstrap install smoke: bootstrap, onboard, sandbox health, live inference, cleanup",
    ]);

    const renamed = listLiveTests({
      enabled: true,
      env: { E2E_TARGET_ID: "bootstrap-install-smoke" },
      files: ["bootstrap-install-smoke.test.ts"],
    });

    expect(renamed.status, renamed.stderr || renamed.stdout).toBe(0);
    expect(linesForFile(renamed.lines, "bootstrap-install-smoke.test.ts")).toEqual([
      "[e2e-live] test/e2e/live/bootstrap-install-smoke.test.ts > bootstrap install smoke: bootstrap, onboard, sandbox health, live inference, cleanup",
    ]);

    const inactive = listLiveTests({
      enabled: true,
      env: { E2E_TARGET_ID: "launchable-smoke" },
      files: ["bootstrap-install-smoke.test.ts"],
    });

    expect(inactive.status, inactive.stderr || inactive.stdout).toBe(0);
    expect(linesForFile(inactive.lines, "bootstrap-install-smoke.test.ts")).toEqual([]);
  });

  it("collects no live files without project opt-in and all live files with it", () => {
    const disabled = listLiveTests({ enabled: false, filesOnly: true });
    const enabled = listLiveTests({ enabled: true, filesOnly: true });
    const discovered = liveTestFiles()
      .map((file) => path.relative(REPO_ROOT, file))
      .sort();
    const collected = enabled.lines.map((line) => line.replace(/^\[e2e-live\]\s+/, "")).sort();

    expect(disabled.status, disabled.stderr || disabled.stdout).toBe(0);
    expect(disabled.lines).toEqual([]);
    expect(enabled.status, enabled.stderr || enabled.stdout).toBe(0);
    expect(collected).toEqual(discovered);
  });

  it(
    "applies each special target's explicit opt-in at real Vitest collection",
    testTimeoutOptions(15_000),
    () => {
      const gatedFiles = [
        ["sandbox-rlimits-connect.test.ts", "NEMOCLAW_E2E_CONNECT_RLIMITS"],
        ["issue-4434-tui-unreachable-inference.test.ts", "NEMOCLAW_ISSUE_4434_LIVE"],
      ] as const;
      const files = gatedFiles.map(([file]) => file);
      const disabled = listLiveTests({ enabled: true, files });

      expect(disabled.status, disabled.stderr || disabled.stdout).toBe(0);
      for (const [file, gate] of gatedFiles) {
        const enabled = listLiveTests({ enabled: true, env: { [gate]: "1" }, files: [file] });

        expect(enabled.status, enabled.stderr || enabled.stdout).toBe(0);
        expect(
          linesForFile(enabled.lines, file).length,
          `${file} should collect more tests when ${gate}=1`,
        ).toBeGreaterThan(linesForFile(disabled.lines, file).length);
      }
    },
  );

  it("collects exactly one reviewed MCP bridge agent shard", testTimeoutOptions(30_000), () => {
    const file = "mcp-bridge.test.ts";
    const expectedTestByShard = {
      deepagents: "mcp-bridge-deepagents",
      hermes: "mcp-bridge-hermes",
      openclaw: "mcp-bridge",
    } as const;

    for (const [shard, expectedTest] of Object.entries(expectedTestByShard)) {
      const result = listLiveTests({
        enabled: true,
        env: { NEMOCLAW_MCP_BRIDGE_AGENT: shard },
        files: [file],
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(linesForFile(result.lines, file)).toEqual([
        `[e2e-live] test/e2e/live/${file} > ${expectedTest}`,
      ]);
    }

    const invalid = listLiveTests({
      enabled: true,
      env: { NEMOCLAW_MCP_BRIDGE_AGENT: "all" },
      files: [file],
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("Unsupported NEMOCLAW_MCP_BRIDGE_AGENT: all");
  });

  it("applies Linux gates at real Vitest collection", () => {
    const linuxTests = [
      [
        "spark-install.test.ts",
        "spark install path: standard non-interactive install leaves NemoClaw and OpenShell usable",
      ],
      [
        "openshell-gateway-upgrade.test.ts",
        "openshell-gateway-upgrade: upgrades old working OpenClaw claw and restores survivor state",
      ],
    ] as const;
    const result = listLiveTests({
      enabled: true,
      files: linuxTests.map(([file]) => file),
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    for (const [file, testName] of linuxTests) {
      expect(linesForFile(result.lines, file).some((line) => line.endsWith(testName))).toBe(
        process.platform === "linux",
      );
    }
  });
});
