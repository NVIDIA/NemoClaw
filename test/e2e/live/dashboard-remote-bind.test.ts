// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { sandboxAccessEnv, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { parseJsonFromText } from "./json-envelope.ts";

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

function stripAnsi(output: string): string {
  return output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function connectStartedDashboardForward(
  result: { exitCode: number | null; stdout: string; stderr: string },
  sandboxName: string,
  dashboardPort: string,
): boolean {
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  return (
    result.exitCode === 0 ||
    (result.exitCode === null &&
      output.includes(`Forwarding port ${dashboardPort}`) &&
      output.includes(`sandbox ${sandboxName}`))
  );
}

runDashboardRemoteBindTest(
  "clean-host remote bind keeps audit risks active and binds all interfaces",
  async ({ artifacts, host, sandbox }) => {
    const sandboxName = process.env.NEMOCLAW_SANDBOX_NAME || "e2e-test";
    const dashboardPort = process.env.NEMOCLAW_DASHBOARD_PORT || "18789";
    const remoteHost = remoteHostCandidate();

    await artifacts.target.declare({
      id: "dashboard-remote-bind",
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
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(cliProbe.exitCode, `required CLI probe failed\n${cliProbe.stderr}`).toBe(0);
    expect(cliProbe.stdout).toContain("nemoclaw");
    expect(cliProbe.stdout).toContain("openshell");

    await sandbox.openshell(["forward", "stop", dashboardPort], {
      artifactName: "dashboard-remote-bind-forward-stop",
      env: sandboxAccessEnv(),
      timeoutMs: 30_000,
    });

    const connect = await host.nemoclaw([sandboxName, "connect"], {
      artifactName: "dashboard-remote-bind-connect",
      env: {
        ...buildAvailabilityProbeEnv(),
        NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
      },
      timeoutMs: 120_000,
    });
    expect(
      connectStartedDashboardForward(connect, sandboxName, dashboardPort),
      `nemoclaw connect did not complete or print background-forward proof\nstdout:\n${connect.stdout}\nstderr:\n${connect.stderr}`,
    ).toBe(true);

    const forwardList = await sandbox.openshell(["forward", "list"], {
      artifactName: "dashboard-remote-bind-forward-list",
      env: sandboxAccessEnv(),
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

    const audit = await sandbox.execShell(
      sandboxName,
      trustedSandboxShellScript("openclaw security audit --json"),
      {
        artifactName: "dashboard-remote-bind-security-audit",
        env: sandboxAccessEnv(),
        timeoutMs: 60_000,
      },
    );
    expect(audit.exitCode, `OpenClaw security audit failed\n${audit.stderr}`).toBe(0);
    const auditResult = parseJsonFromText(audit.stdout) as {
      findings: Array<{ checkId: string; detail: string }>;
      suppressedFindings?: unknown[];
    };
    expect(auditResult.suppressedFindings ?? []).toEqual([]);
    expect(auditResult.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "gateway.control_ui.insecure_auth" }),
        expect.objectContaining({ checkId: "gateway.control_ui.device_auth_disabled" }),
        expect.objectContaining({
          checkId: "config.insecure_or_dangerous_flags",
          detail: expect.stringContaining(
            "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true",
          ),
        }),
      ]),
    );
  },
);
