// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, type TestContext, vi } from "vitest";

import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { LIVE_E2E_ROOT, REPO_ROOT } from "../fixtures/paths.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { buildChildEnv, redactString } from "../fixtures/redaction.ts";
import { ShellProbe, trustedShellCommand } from "../fixtures/shell-probe.ts";
import { listTargets } from "../registry/registry.ts";
import { liveTargetSupport } from "../registry/runtime-support.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const COLLECTION_ENV = [
  "E2E_TARGET_ID",
  "NEMOCLAW_ISSUE_4434_LIVE",
  "NEMOCLAW_MCP_BRIDGE_AGENT",
  "TARGET_ID",
] as const;
const COLLECTOR_TIMEOUT_MS = 30_000;

// Each case starts a nested Vitest collector; cap overlap to bound memory.
vi.setConfig({ maxConcurrency: 3 });

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

type LiveTestListOptions = {
  enabled: boolean;
  env?: Partial<Record<(typeof COLLECTION_ENV)[number], string>>;
  files?: readonly string[];
  filesOnly?: boolean;
};

function collectorTimeoutOptions(count = 1) {
  return testTimeoutOptions(count * COLLECTOR_TIMEOUT_MS + 5_000);
}

function buildLiveTestEnv(
  base: NodeJS.ProcessEnv,
  options: Pick<LiveTestListOptions, "enabled" | "env">,
): NodeJS.ProcessEnv {
  return buildChildEnv(base, {
    fixtureOverlay: {
      NEMOCLAW_RUN_LIVE_E2E: options.enabled ? "1" : undefined,
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: undefined,
      NEMOCLAW_PROVIDER: "nvidia",
      ...Object.fromEntries(COLLECTION_ENV.map((name) => [name, undefined])),
      ...options.env,
    },
  });
}

function liveTestLister(context: Pick<TestContext, "signal" | "onTestFinished">) {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-test-list-"));
  const progress = startTestProgress("nested live E2E collection", [
    "collect live tests",
    "clean collector artifacts",
  ]);
  const probe = new ShellProbe({
    artifacts: new ArtifactSink(artifactRoot),
    progress,
    redact: redactString,
    signal: context.signal,
  });
  context.onTestFinished(() => {
    progress.phase("clean collector artifacts");
    progress.stop();
    fs.rmSync(artifactRoot, { force: true, recursive: true });
  });

  return async (options: LiveTestListOptions) => {
    const args = [
      "list",
      "--project",
      "e2e-live",
      ...(options.files ?? []).map((file) => `test/e2e/live/${file}`),
      ...(options.filesOnly ? ["--filesOnly"] : []),
      "--passWithNoTests",
    ];
    const result = await probe.run(
      trustedShellCommand({
        command: process.execPath,
        args: [VITEST, ...args],
        reason: "collect the live E2E tests selected by the registry gates",
      }),
      {
        captureLimitBytes: 1024 * 1024,
        cwd: REPO_ROOT,
        env: buildLiveTestEnv(process.env, options),
        killGraceMs: 0,
        persistArtifacts: false,
        timeoutMs: COLLECTOR_TIMEOUT_MS,
      },
    );
    return {
      status: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      lines: result.stdout.split(/\r?\n/).filter((line) => line.startsWith("[e2e-live] ")),
    };
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
  it("strips ambient credentials from nested collector environments", () => {
    const env = buildLiveTestEnv(
      {
        AMBIENT_API_KEY: "must-not-reach-the-collector",
        PATH: "/usr/bin",
      },
      {
        enabled: true,
        env: {
          E2E_TARGET_ID: "launchable-smoke",
          NEMOCLAW_ISSUE_4434_LIVE: "1",
          NEMOCLAW_MCP_BRIDGE_AGENT: "openclaw",
          TARGET_ID: "declared-target",
        },
      },
    );

    expect(env).not.toHaveProperty("AMBIENT_API_KEY");
    expect(env).toMatchObject({
      E2E_TARGET_ID: "launchable-smoke",
      NEMOCLAW_ISSUE_4434_LIVE: "1",
      NEMOCLAW_MCP_BRIDGE_AGENT: "openclaw",
      NEMOCLAW_PROVIDER: "nvidia",
      NEMOCLAW_RUN_LIVE_E2E: "1",
      TARGET_ID: "declared-target",
    });
  });

  it(
    "keeps the formatted bootstrap entry point valid through real Vitest collection",
    testTimeoutOptions(35_000),
    () => {
      const formatted = spawnSync(
        process.execPath,
        [
          path.join(REPO_ROOT, "node_modules", "oxfmt", "bin", "oxfmt"),
          "--check",
          path.join(LIVE_E2E_ROOT, "bootstrap-install-smoke.test.ts"),
        ],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 },
      );
      expect(formatted.status, formatted.stderr || formatted.stdout).toBe(0);
    },
  );

  it.concurrent(
    "collects the bootstrap install test through the trusted-main legacy path",
    collectorTimeoutOptions(3),
    async (context) => {
      const listLiveTests = liveTestLister(context);
      const legacy = await listLiveTests({
        enabled: true,
        env: { E2E_TARGET_ID: "launchable-smoke" },
        files: ["launchable-smoke.test.ts"],
      });

      context.expect(legacy.status, legacy.stderr || legacy.stdout).toBe(0);
      context
        .expect(linesForFile(legacy.lines, "launchable-smoke.test.ts"))
        .toEqual([
          "[e2e-live] test/e2e/live/launchable-smoke.test.ts > bootstrap install smoke: bootstrap, onboard, sandbox health, live inference, cleanup",
        ]);

      const renamed = await listLiveTests({
        enabled: true,
        env: { E2E_TARGET_ID: "bootstrap-install-smoke" },
        files: ["bootstrap-install-smoke.test.ts"],
      });

      context.expect(renamed.status, renamed.stderr || renamed.stdout).toBe(0);
      context
        .expect(linesForFile(renamed.lines, "bootstrap-install-smoke.test.ts"))
        .toEqual([
          "[e2e-live] test/e2e/live/bootstrap-install-smoke.test.ts > bootstrap install smoke: bootstrap, onboard, sandbox health, live inference, cleanup",
        ]);

      const inactive = await listLiveTests({
        enabled: true,
        env: { E2E_TARGET_ID: "launchable-smoke" },
        files: ["bootstrap-install-smoke.test.ts"],
      });

      context.expect(inactive.status, inactive.stderr || inactive.stdout).toBe(0);
      context.expect(linesForFile(inactive.lines, "bootstrap-install-smoke.test.ts")).toEqual([]);
    },
  );

  it.concurrent(
    "collects no live files without project opt-in and all live files with it",
    collectorTimeoutOptions(2),
    async (context) => {
      const listLiveTests = liveTestLister(context);
      const disabled = await listLiveTests({ enabled: false, filesOnly: true });
      const enabled = await listLiveTests({ enabled: true, filesOnly: true });
      const discovered = liveTestFiles()
        .map((file) => path.relative(REPO_ROOT, file))
        .sort();
      const collected = enabled.lines.map((line) => line.replace(/^\[e2e-live\]\s+/, "")).sort();

      context.expect(disabled.status, disabled.stderr || disabled.stdout).toBe(0);
      context.expect(disabled.lines).toEqual([]);
      context.expect(enabled.status, enabled.stderr || enabled.stdout).toBe(0);
      context.expect(collected).toEqual(discovered);
    },
  );

  it.concurrent(
    "applies the issue-4434 live opt-in at real Vitest collection",
    collectorTimeoutOptions(2),
    async (context) => {
      const listLiveTests = liveTestLister(context);
      const file = "issue-4434-tui-unreachable-inference.test.ts";
      const gate = "NEMOCLAW_ISSUE_4434_LIVE";
      const disabled = await listLiveTests({ enabled: true, files: [file] });

      context.expect(disabled.status, disabled.stderr || disabled.stdout).toBe(0);
      const enabled = await listLiveTests({
        enabled: true,
        env: { [gate]: "1" },
        files: [file],
      });

      context.expect(enabled.status, enabled.stderr || enabled.stdout).toBe(0);
      context
        .expect(
          linesForFile(enabled.lines, file).length,
          `${file} should collect more tests when ${gate}=1`,
        )
        .toBeGreaterThan(linesForFile(disabled.lines, file).length);
    },
  );

  it.concurrent.for([
    { shard: "deepagents", expectedTest: "mcp-bridge-deepagents" },
    { shard: "hermes", expectedTest: "mcp-bridge-hermes" },
    { shard: "openclaw", expectedTest: "mcp-bridge" },
  ] as const)(
    "collects exactly the reviewed $shard MCP bridge agent shard",
    collectorTimeoutOptions(),
    async ({ shard, expectedTest }, context) => {
      const listLiveTests = liveTestLister(context);
      const file = "mcp-bridge.test.ts";
      const result = await listLiveTests({
        enabled: true,
        env: { NEMOCLAW_MCP_BRIDGE_AGENT: shard },
        files: [file],
      });

      context.expect(result.status, result.stderr || result.stdout).toBe(0);
      context
        .expect(linesForFile(result.lines, file))
        .toEqual([`[e2e-live] test/e2e/live/${file} > ${expectedTest}`]);
    },
  );

  it.concurrent(
    "rejects an unreviewed MCP bridge agent shard",
    collectorTimeoutOptions(),
    async (context) => {
      const listLiveTests = liveTestLister(context);
      const file = "mcp-bridge.test.ts";
      const invalid = await listLiveTests({
        enabled: true,
        env: { NEMOCLAW_MCP_BRIDGE_AGENT: "all" },
        files: [file],
      });
      context.expect(invalid.status).not.toBe(0);
      context.expect(invalid.stderr).toContain("Unsupported NEMOCLAW_MCP_BRIDGE_AGENT: all");
    },
  );

  it.concurrent(
    "rejects a TARGET_ID no registry target declares (#8286)",
    collectorTimeoutOptions(3),
    async (context) => {
      const listLiveTests = liveTestLister(context);
      const file = "registry-targets.test.ts";

      // The workflow selects one target by its stable title prefix. An ID no
      // target declares matches nothing, so the run would collect no test and
      // exit 0 having executed no target.
      const unknown = await listLiveTests({
        enabled: true,
        env: { TARGET_ID: "does-not-exist" },
        files: [file],
      });

      context.expect(unknown.status, unknown.stdout).not.toBe(0);
      context
        .expect(`${unknown.stdout}${unknown.stderr}`)
        .toContain("Unknown target 'does-not-exist'");

      const empty = await listLiveTests({ enabled: true, env: { TARGET_ID: "" }, files: [file] });

      context.expect(empty.status, empty.stdout).not.toBe(0);
      context.expect(`${empty.stdout}${empty.stderr}`).toContain("Selected target ID ''");

      const unsafe = await listLiveTests({
        enabled: true,
        env: { TARGET_ID: "unsafe/id" },
        files: [file],
      });

      context.expect(unsafe.status, unsafe.stdout).not.toBe(0);
      context
        .expect(`${unsafe.stdout}${unsafe.stderr}`)
        .toContain("Selected target ID 'unsafe/id'");
    },
  );

  it.concurrent.for([{ wired: true }, { wired: false }])(
    "collects registry targets when wired is $wired for a declared TARGET_ID (#8286)",
    collectorTimeoutOptions(),
    async ({ wired }, context) => {
      const listLiveTests = liveTestLister(context);
      const file = "registry-targets.test.ts";

      // The check rejects only ids the registry does not declare, so a wired id
      // and a declared placeholder both still collect. Collecting at least one
      // test proves the file was evaluated rather than skipped outright.
      const result = await listLiveTests({
        enabled: true,
        env: { TARGET_ID: declaredTargetId({ wired }) },
        files: [file],
      });

      context.expect(result.status, result.stderr || result.stdout).toBe(0);
      context.expect(linesForFile(result.lines, file).length).toBeGreaterThan(0);
    },
  );

  it.concurrent.for([
    {
      file: "spark-install.test.ts",
      testName:
        "spark install path: standard non-interactive install leaves NemoClaw and OpenShell usable",
    },
    {
      file: "openshell-gateway-upgrade.test.ts",
      testName:
        "openshell-gateway-upgrade: preserves a usable sandbox and workspace state (#10517)",
    },
  ] as const)(
    "applies the Linux gate to $file at real Vitest collection",
    collectorTimeoutOptions(),
    async ({ file, testName }, context) => {
      const listLiveTests = liveTestLister(context);
      const result = await listLiveTests({
        enabled: true,
        files: [file],
      });

      context.expect(result.status, result.stderr || result.stdout).toBe(0);
      context
        .expect(linesForFile(result.lines, file).some((line) => line.endsWith(testName)))
        .toBe(process.platform === "linux");
    },
  );
});
