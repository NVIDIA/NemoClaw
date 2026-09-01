// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { LIVE_E2E_ROOT, REPO_ROOT } from "../fixtures/paths.ts";
import { listTargets } from "../registry/registry.ts";
import { liveTargetSupport } from "../registry/runtime-support.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const SPECIAL_GATE_ENV = ["NEMOCLAW_ISSUE_4434_LIVE", "NEMOCLAW_MCP_BRIDGE_AGENT"] as const;

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

/**
 * A registered target ID. `wired: true` selects one the live fixtures support;
 * `wired: false` selects a declared placeholder the live matrix skips.
 */
function declaredTargetId({ wired }: { wired: boolean }): string {
  const match = listTargets().find(
    (registered) => liveTargetSupport(registered).supported === wired,
  );
  return match?.id ?? missingDeclaredTarget(wired);
}

function missingDeclaredTarget(wired: boolean): never {
  throw new Error(`registry declares no ${wired ? "wired" : "not wired"} target`);
}

describe("live E2E target gating", () => {
  it(
    "collects the bootstrap install test through the trusted-main legacy path",
    testTimeoutOptions(90_000),
    () => {
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
    },
  );

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

  it.each([["issue-4434-tui-unreachable-inference.test.ts", "NEMOCLAW_ISSUE_4434_LIVE"]] as const)(
    "applies the %s special target's %s opt-in at real Vitest collection",
    testTimeoutOptions(15_000),
    (file, gate) => {
      const disabled = listLiveTests({ enabled: true, files: [file] });

      expect(disabled.status, disabled.stderr || disabled.stdout).toBe(0);
      const enabled = listLiveTests({ enabled: true, env: { [gate]: "1" }, files: [file] });

      expect(enabled.status, enabled.stderr || enabled.stdout).toBe(0);
      expect(
        linesForFile(enabled.lines, file).length,
        `${file} should collect more tests when ${gate}=1`,
      ).toBeGreaterThan(linesForFile(disabled.lines, file).length);
    },
  );

  it.each([
    ["deepagents", "mcp-bridge-deepagents"],
    ["hermes", "mcp-bridge-hermes"],
    ["openclaw", "mcp-bridge"],
  ] as const)(
    "collects exactly the reviewed %s MCP bridge agent shard",
    testTimeoutOptions(30_000),
    (shard, expectedTest) => {
      const file = "mcp-bridge.test.ts";
      const result = listLiveTests({
        enabled: true,
        env: { NEMOCLAW_MCP_BRIDGE_AGENT: shard },
        files: [file],
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(linesForFile(result.lines, file)).toEqual([
        `[e2e-live] test/e2e/live/${file} > ${expectedTest}`,
      ]);
    },
  );

  it("rejects an unreviewed MCP bridge agent shard", testTimeoutOptions(30_000), () => {
    const file = "mcp-bridge.test.ts";
    const invalid = listLiveTests({
      enabled: true,
      env: { NEMOCLAW_MCP_BRIDGE_AGENT: "all" },
      files: [file],
    });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("Unsupported NEMOCLAW_MCP_BRIDGE_AGENT: all");
  });

  it("rejects a TARGET_ID no registry target declares (#8286)", testTimeoutOptions(30_000), () => {
    const file = "registry-targets.test.ts";

    // The workflow selects one target by its stable title prefix. An ID no
    // target declares matches nothing, so the run would collect no test and
    // exit 0 having executed no target.
    const unknown = listLiveTests({
      enabled: true,
      env: { TARGET_ID: "does-not-exist" },
      files: [file],
    });

    expect(unknown.status, unknown.stdout).not.toBe(0);
    expect(`${unknown.stdout}${unknown.stderr}`).toContain("Unknown target 'does-not-exist'");

    const empty = listLiveTests({ enabled: true, env: { TARGET_ID: "" }, files: [file] });

    expect(empty.status, empty.stdout).not.toBe(0);
    expect(`${empty.stdout}${empty.stderr}`).toContain("Selected target ID ''");

    const unsafe = listLiveTests({
      enabled: true,
      env: { TARGET_ID: "unsafe/id" },
      files: [file],
    });

    expect(unsafe.status, unsafe.stdout).not.toBe(0);
    expect(`${unsafe.stdout}${unsafe.stderr}`).toContain("Selected target ID 'unsafe/id'");
  });

  it.each([true, false])(
    "collects registry targets when wired is %s for a declared TARGET_ID (#8286)",
    testTimeoutOptions(30_000),
    (wired) => {
      const file = "registry-targets.test.ts";

      // The check rejects only ids the registry does not declare, so a wired id
      // and a declared placeholder both still collect. Collecting at least one
      // test proves the file was evaluated rather than skipped outright.
      const result = listLiveTests({
        enabled: true,
        env: { TARGET_ID: declaredTargetId({ wired }) },
        files: [file],
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(linesForFile(result.lines, file).length).toBeGreaterThan(0);
    },
  );

  it.each([
    [
      "spark-install.test.ts",
      "spark install path: standard non-interactive install leaves NemoClaw and OpenShell usable",
    ],
    [
      "openshell-gateway-upgrade.test.ts",
      "openshell-gateway-upgrade: preserves live OpenShell state or fails closed without it",
    ],
  ] as const)("applies the Linux gate to %s at real Vitest collection", (file, testName) => {
    const result = listLiveTests({
      enabled: true,
      files: [file],
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(linesForFile(result.lines, file).some((line) => line.endsWith(testName))).toBe(
      process.platform === "linux",
    );
  });
});
