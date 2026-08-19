// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("accepts a normally completed connect when the forward is already healthy", async ({
  artifacts,
  progress,
}) => {
  const result = await runDashboardConnectUntilForwardHandoff({
    artifacts,
    command: [process.execPath, "-e", "process.exit(0)"],
    dashboardPort: DASHBOARD_PORT,
    env: process.env,
    progress,
    sandboxName: SANDBOX_NAME,
    timeoutMs: 2_000,
  });

  expect(result).toMatchObject({ exitCode: 0, proof: "command-completed", signal: null });
});

test("rejects invalid handoff budgets before spawning connect", async ({ artifacts, progress }) => {
  const base = {
    artifacts,
    command: [process.execPath, "-e", "process.exit(0)"] as const,
    dashboardPort: DASHBOARD_PORT,
    env: process.env,
    progress,
    sandboxName: SANDBOX_NAME,
  };

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
      "fs.writeFileSync(process.argv[1], String(forward.pid));",
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
      env: process.env,
      progress,
      sandboxName: SANDBOX_NAME,
      timeoutMs: 2_000,
    });

    forwardPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(result.proof).toBe("forward-started");
    expect(result.stdout).toContain("Dashboard port forward re-established.");
    expect(processExists(forwardPid)).toBe(true);
  } finally {
    try {
      process.kill(forwardPid, "SIGTERM");
    } catch {
      // The fixture may not have reached background process creation.
    }
    await waitForProcessExit(forwardPid);
    expect(processExists(forwardPid)).toBe(false);
    fs.rmSync(directory, { force: true, recursive: true });
  }
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
      env: process.env,
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
      env: process.env,
      progress,
      sandboxName: SANDBOX_NAME,
      stopGraceMs: 100,
      timeoutMs: 100,
    }),
  ).rejects.toThrow(/did not complete or prove forward handoff within budget/);
});
