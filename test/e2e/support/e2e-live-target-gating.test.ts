// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LIVE_E2E_ROOT, REPO_ROOT } from "../fixtures/paths.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const SPECIAL_GATE_ENV = [
  "NEMOCLAW_E2E_CONNECT_RLIMITS",
  "NEMOCLAW_ISSUE_4434_LIVE",
  "NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX",
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
  file?: string;
  filesOnly?: boolean;
}) {
  const args = [
    "list",
    "--project",
    "e2e-live",
    ...(options.file ? [`test/e2e/live/${options.file}`] : []),
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

describe("live E2E target gating", () => {
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

  it.each([
    ["sandbox-rlimits-connect.test.ts", "NEMOCLAW_E2E_CONNECT_RLIMITS"],
    ["mcp-bridge.test.ts", "NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX"],
    ["issue-4434-tui-unreachable-inference.test.ts", "NEMOCLAW_ISSUE_4434_LIVE"],
  ] as const)("applies %s's explicit opt-in at real Vitest collection", (file, gate) => {
    const disabled = listLiveTests({ enabled: true, file });
    const enabled = listLiveTests({ enabled: true, env: { [gate]: "1" }, file });

    expect(disabled.status, disabled.stderr || disabled.stdout).toBe(0);
    expect(enabled.status, enabled.stderr || enabled.stdout).toBe(0);
    expect(
      enabled.lines.length,
      `${file} should collect more tests when ${gate}=1`,
    ).toBeGreaterThan(disabled.lines.length);
  });

  it.each([
    [
      "spark-install.test.ts",
      "spark install path: standard non-interactive install leaves NemoClaw and OpenShell usable",
    ],
    [
      "openshell-gateway-upgrade.test.ts",
      "openshell-gateway-upgrade: upgrades old working OpenClaw claw and restores survivor state",
    ],
  ])("applies %s's Linux gate at real Vitest collection", (file, testName) => {
    const result = listLiveTests({ enabled: true, file });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.lines.some((line) => line.endsWith(testName))).toBe(process.platform === "linux");
  });
});
