// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LIVE_E2E_ROOT, REPO_ROOT } from "../fixtures/paths.ts";

const REDUNDANT_LIVE_GATE =
  /shouldRunLiveE2E\s*\(|process\.env\.NEMOCLAW_RUN_LIVE_E2E\s*===\s*["']1["']|from\s*["'][^"']*\/live-project-gate\.ts["']/;

const SPECIAL_LIVE_TARGET_GATES = [
  {
    file: "sandbox-rlimits-connect.test.ts",
    gates: [/NEMOCLAW_E2E_CONNECT_RLIMITS\s*===\s*["']1["']/, /\?\s*test\s*:\s*test\.skip/],
  },
  {
    file: "mcp-bridge.test.ts",
    gates: [/NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX\s*===\s*["']1["']/, /\?\s*test\s*:\s*test\.skip/],
  },
  {
    file: "issue-4434-tui-unreachable-inference.test.ts",
    gates: [
      /NEMOCLAW_ISSUE_4434_LIVE\s*===\s*["']1["']/,
      /test\.skipIf\(HOSTED_INFERENCE_IS_GATEWAY_MANAGED\)/,
    ],
  },
  {
    file: "spark-install.test.ts",
    gates: [/process\.platform\s*===\s*["']linux["']\s*\?\s*test\s*:\s*test\.skip/],
  },
  {
    file: "openshell-gateway-upgrade.test.ts",
    gates: [/test\.skipIf\(process\.platform\s*!==\s*["']linux["']\)/],
  },
];

function liveTestFiles(root = LIVE_E2E_ROOT): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory()
      ? liveTestFiles(target)
      : entry.isFile() && entry.name.endsWith(".test.ts")
        ? [target]
        : [];
  });
}

function readLiveTest(file: string): string {
  return fs.readFileSync(path.join(LIVE_E2E_ROOT, file), "utf8");
}

describe("live E2E target gating", () => {
  it("leaves the default opt-in gate at Vitest project collection", () => {
    const violations = liveTestFiles()
      .filter((file) => REDUNDANT_LIVE_GATE.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(LIVE_E2E_ROOT, file));

    expect(violations).toEqual([]);
  });

  it("preserves special target opt-in and platform gates", () => {
    const missing = SPECIAL_LIVE_TARGET_GATES.flatMap(({ file, gates }) => {
      const source = readLiveTest(file);
      return gates
        .filter((gate) => !gate.test(source))
        .map((gate) => `${file}: ${gate.toString()}`);
    });

    expect(missing).toEqual([]);
  });

  it("does not collect a direct live target filter without the live opt-in", () => {
    const env = { ...process.env, NEMOCLAW_RUN_LIVE_E2E: undefined };
    const result = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"),
        "list",
        "--project",
        "e2e-live",
        "test/e2e/live/cloud-onboard.test.ts",
        "--passWithNoTests",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env,
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("cloud-onboard");
  });
});
