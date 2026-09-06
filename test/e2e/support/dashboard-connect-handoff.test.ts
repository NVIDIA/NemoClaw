// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { runDashboardConnectUntilForwardHandoff } from "../live/dashboard-connect-handoff.ts";

const SANDBOX_NAME = "e2e-dashboard-bind";
const DASHBOARD_PORT = "18789";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopFixtureProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The forward may have already exited.
  }
  await waitForProcessExit(pid);
  expect(processExists(pid)).toBe(false);
}

test("accepts a normally completed connect with the local Dockerfile workload", async ({
  artifacts,
  progress,
}) => {
  const result = await runDashboardConnectUntilForwardHandoff({
    artifacts,
    command: [
      process.execPath,
      "-e",
      "process.exit(process.env.NEMOCLAW_FROM_DOCKERFILE === process.argv[1] ? 0 : 1)",
      path.resolve("Dockerfile"),
    ],
    dashboardPort: DASHBOARD_PORT,
    env: {
      ...buildAvailabilityProbeEnv(),
      E2E_TARGET_ID: "dashboard-remote-bind",
      E2E_WORKLOAD_SOURCE: "local-dockerfile",
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_FROM_DOCKERFILE: path.resolve("Dockerfile"),
    },
    progress,
    sandboxName: SANDBOX_NAME,
    timeoutMs: 2_000,
  });

  expect(result).toMatchObject({ exitCode: 0, proof: "command-completed", signal: null });
});

test("rejects invalid handoff budgets before spawning connect", async ({ artifacts, progress }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-handoff-budget-"));
  const marker = path.join(directory, "spawned");
  const base = {
    artifacts,
    command: [
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync(process.argv[1], "1")',
      marker,
    ] as const,
    dashboardPort: DASHBOARD_PORT,
    env: buildAvailabilityProbeEnv(),
    progress,
    sandboxName: SANDBOX_NAME,
  };

  try {
    await expect(runDashboardConnectUntilForwardHandoff({ ...base, timeoutMs: 0 })).rejects.toThrow(
      /timeout must be a positive finite value/,
    );
    await expect(
      runDashboardConnectUntilForwardHandoff({
        ...base,
        stopGraceMs: Number.POSITIVE_INFINITY,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/stop grace must be a positive finite value/);
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("reaps interactive connect after missing-forward proof while its detached forward survives", async ({
  artifacts,
  progress,
}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-connect-handoff-"));
  const pidFile = path.join(directory, "forward.pid");
  let forwardPid = Number.NaN;
  try {
    const script = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      'const forward = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" });',
      "forward.unref();",
      "try { fs.writeFileSync(process.argv[1], String(forward.pid)); } catch (error) { forward.kill('SIGTERM'); throw error; }",
      `process.stdout.write(${JSON.stringify(
        `Dashboard port forward to '${SANDBOX_NAME}' is missing or dead.\nRe-establishing...\n\u001B[32m✓\u001B[0m Dashboard port forward re-established.\n`,
      )});`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => undefined, 1000);",
    ].join("\n");
    const result = await runDashboardConnectUntilForwardHandoff({
      artifacts,
      command: [process.execPath, "-e", script, pidFile],
      dashboardPort: DASHBOARD_PORT,
      env: buildAvailabilityProbeEnv(),
      progress,
      sandboxName: SANDBOX_NAME,
      timeoutMs: 2_000,
    });

    forwardPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(result.proof).toBe("forward-started");
    expect(result.stdout).toContain("Dashboard port forward re-established.");
    expect(processExists(forwardPid)).toBe(true);
  } finally {
    const cleanupPid = Number.isInteger(forwardPid)
      ? forwardPid
      : Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : Number.NaN);
    try {
      expect(
        Number.isInteger(cleanupPid) && cleanupPid > 0,
        "fixture forward PID is unavailable; detached cleanup cannot be proven",
      ).toBe(true);
      await stopFixtureProcess(cleanupPid);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  }
});

test("accepts direct ForwardTcp ownership proof without parsing legacy CLI output", async ({
  artifacts,
  progress,
}) => {
  let probes = 0;
  const script = [
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => undefined, 1000);",
  ].join("\n");
  const result = await runDashboardConnectUntilForwardHandoff({
    artifacts,
    command: [process.execPath, "-e", script],
    dashboardPort: DASHBOARD_PORT,
    env: {},
    forwardProbe: () => (probes += 1) >= 2,
    forwardProbeIntervalMs: 10,
    progress,
    sandboxName: SANDBOX_NAME,
    timeoutMs: 2_000,
  });

  expect(result.proof).toBe("forward-started");
  expect(probes).toBeGreaterThanOrEqual(2);
});

test("fails when an attached descendant retains captured stdio after forward proof", async ({
  artifacts,
  progress,
}) => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "inherit" });',
    `process.stdout.write(${JSON.stringify(
      "\u001B[32m✓\u001B[0m Dashboard port forward re-established.\n",
    )});`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => undefined, 1000);",
  ].join("\n");

  await expect(
    runDashboardConnectUntilForwardHandoff({
      artifacts,
      command: [process.execPath, "-e", script],
      dashboardPort: DASHBOARD_PORT,
      env: buildAvailabilityProbeEnv(),
      progress,
      sandboxName: SANDBOX_NAME,
      stopGraceMs: 100,
      timeoutMs: 2_000,
    }),
  ).rejects.toThrow(/retained captured descriptors/);
});

test("fails within budget and reaps a connect process that never proves handoff", async ({
  artifacts,
  progress,
}) => {
  await expect(
    runDashboardConnectUntilForwardHandoff({
      artifacts,
      command: [process.execPath, "-e", "setInterval(() => undefined, 1000)"],
      dashboardPort: DASHBOARD_PORT,
      env: buildAvailabilityProbeEnv(),
      progress,
      sandboxName: SANDBOX_NAME,
      stopGraceMs: 100,
      timeoutMs: 100,
    }),
  ).rejects.toThrow(/did not complete or prove forward handoff within budget/);
});
