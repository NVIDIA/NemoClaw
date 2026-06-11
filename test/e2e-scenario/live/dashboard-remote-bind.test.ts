// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { expect, test } from "../fixtures/e2e-test.ts";

// Migrated from test/e2e/test-dashboard-remote-bind.sh.
// Branch validation provisions and onboards a real remote sandbox first; this
// test restarts only that sandbox's dashboard forward and proves the explicit
// remote-bind opt-in is honored without adding another harness.

const runDashboardRemoteBindTest =
  process.env.NEMOCLAW_E2E_DASHBOARD_REMOTE_BIND === "1" ? test : test.skip;

function matchingForwardLine(output: string, sandboxName: string, dashboardPort: string): string {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes(sandboxName) && line.includes(dashboardPort)) ?? ""
  );
}

function bindsAllInterfaces(line: string, dashboardPort: string): boolean {
  return (
    line.includes(`0.0.0.0:${dashboardPort}`) ||
    line.includes(`*:${dashboardPort}`) ||
    new RegExp(`\\b0\\.0\\.0\\.0\\s+${dashboardPort}\\b`).test(line)
  );
}

function bindsLoopback(line: string, dashboardPort: string): boolean {
  return (
    line.includes(`127.0.0.1:${dashboardPort}`) ||
    line.includes(`localhost:${dashboardPort}`) ||
    new RegExp(`\\b127\\.0\\.0\\.1\\s+${dashboardPort}\\b`).test(line)
  );
}

function remoteHostCandidate(): string {
  const externalIpv4 = Object.values(os.networkInterfaces())
    .flat()
    .find((iface) => iface && iface.family === "IPv4" && !iface.internal)?.address;
  return process.env.NEMOCLAW_E2E_REMOTE_HOST || externalIpv4 || os.hostname();
}

runDashboardRemoteBindTest(
  "dashboard forward binds all interfaces when remote bind is explicitly requested",
  async ({ artifacts, host, sandbox }) => {
    const sandboxName = process.env.NEMOCLAW_SANDBOX_NAME || "e2e-test";
    const dashboardPort = process.env.NEMOCLAW_DASHBOARD_PORT || "18789";
    const remoteHost = remoteHostCandidate();

    await artifacts.writeJson("scenario.json", {
      id: "dashboard-remote-bind",
      runner: "vitest",
      migratedFrom: "test/e2e/test-dashboard-remote-bind.sh",
      boundary: "remote-dashboard-forward",
      optIn: "NEMOCLAW_E2E_DASHBOARD_REMOTE_BIND=1",
      sandboxName,
      dashboardPort,
      remoteHost,
    });

    const cliProbe = await host.command(
      "bash",
      ["-lc", "command -v nemoclaw && command -v openshell"],
      {
        artifactName: "dashboard-remote-bind-cli-probe",
        inheritEnv: true,
        timeoutMs: 30_000,
      },
    );
    expect(cliProbe.exitCode, `required CLI probe failed\n${cliProbe.stderr}`).toBe(0);
    expect(cliProbe.stdout).toContain("nemoclaw");
    expect(cliProbe.stdout).toContain("openshell");

    await sandbox.openshell(["forward", "stop", dashboardPort], {
      artifactName: "dashboard-remote-bind-forward-stop",
      inheritEnv: true,
      timeoutMs: 30_000,
    });

    const connect = await host.nemoclaw([sandboxName, "connect"], {
      artifactName: "dashboard-remote-bind-connect",
      inheritEnv: true,
      env: {
        NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
      },
      timeoutMs: 120_000,
    });
    expect(connect.exitCode, `nemoclaw connect failed\n${connect.stderr}`).toBe(0);

    const forwardList = await sandbox.openshell(["forward", "list"], {
      artifactName: "dashboard-remote-bind-forward-list",
      inheritEnv: true,
      timeoutMs: 30_000,
    });
    expect(forwardList.exitCode, `openshell forward list failed\n${forwardList.stderr}`).toBe(0);
    await artifacts.writeText("forward-list.txt", forwardList.stdout);

    const forwardLine = matchingForwardLine(forwardList.stdout, sandboxName, dashboardPort);
    expect(
      forwardLine,
      `No OpenShell forward found for ${sandboxName} on ${dashboardPort}`,
    ).not.toBe("");
    expect(
      bindsLoopback(forwardLine, dashboardPort),
      `Dashboard forward is still localhost-only; expected an all-interface bind: ${forwardLine}`,
    ).toBe(false);
    expect(
      bindsAllInterfaces(forwardLine, dashboardPort),
      `Could not prove dashboard forward uses 0.0.0.0:${dashboardPort}: ${forwardLine}`,
    ).toBe(true);
  },
);
