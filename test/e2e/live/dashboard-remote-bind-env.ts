// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

function stripAnsi(output: string): string {
  return output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function buildDashboardRemoteBindEnv(
  sandboxName: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const baseEnv = buildAvailabilityProbeEnv();
  return {
    ...baseEnv,
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${baseEnv.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
    NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
  };
}

export function dashboardRemoteBindConnectStarted(
  result: {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  },
  sandboxName: string,
  dashboardPort: string,
): boolean {
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  return (
    result.exitCode === 0 ||
    ((result.exitCode === null || result.timedOut === true) &&
      (output.includes("Dashboard port forward re-established.") ||
        (output.includes(`Forwarding port ${dashboardPort}`) &&
          output.includes(`sandbox ${sandboxName}`))))
  );
}

export function dashboardForwardIsRunning(forwardLine: string): boolean {
  const columns = stripAnsi(forwardLine).trim().split(/\s+/u);
  return columns.length === 5 && columns[4] === "running";
}
