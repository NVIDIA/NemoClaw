// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import {
  isSandboxPortForwardHealthy,
  teardownSandboxDashboardForward,
} from "../../../src/lib/actions/sandbox/forward-recovery.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { sandboxAccessEnv, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { buildDashboardRemoteBindEnv } from "./dashboard-remote-bind-env.ts";
import { parseJsonFromText } from "./json-envelope.ts";

const runDashboardRemoteBindTest =
  process.env.NEMOCLAW_E2E_DASHBOARD_REMOTE_BIND === "1" ? test : test.skip;
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME || "e2e-dashboard-bind";
const TEST_TIMEOUT_MS = 50 * 60_000;

function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return buildDashboardRemoteBindEnv(SANDBOX_NAME, extra);
}

function remoteHostCandidate(): string {
  const externalIpv4 = Object.values(os.networkInterfaces())
    .flat()
    .find((iface) => iface && iface.family === "IPv4" && !iface.internal)?.address;
  return process.env.NEMOCLAW_E2E_REMOTE_HOST || externalIpv4 || os.hostname();
}

runDashboardRemoteBindTest(
  "clean-host remote bind keeps audit risks active and binds all interfaces",
  {
    timeout: TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "validate dashboard prerequisites",
        "install and onboard dashboard sandbox",
        "stop sandbox and restart dashboard with remote binding",
        "verify all-interface dashboard forward",
        "audit exposed dashboard controls",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox, secrets }) => {
    const sandboxName = SANDBOX_NAME;
    const dashboardPort = process.env.NEMOCLAW_DASHBOARD_PORT || "18789";
    const remoteHost = remoteHostCandidate();
    const hosted = requireHostedInferenceConfig(secrets);
    const redactionValues = [hosted.apiKey];

    await artifacts.target.declare({
      id: "dashboard-remote-bind",
      boundary: "source-install-onboard-and-remote-dashboard-forward",
      optIn: "NEMOCLAW_E2E_DASHBOARD_REMOTE_BIND=1",
      sandboxName,
      dashboardPort,
      remoteHost,
      contracts: [
        "install.sh onboards a real OpenShell sandbox on the unified Ubuntu E2E runner",
        "NEMOCLAW_DASHBOARD_BIND=0.0.0.0 creates an all-interface dashboard forward",
        "remote binding does not suppress the insecure dashboard audit findings",
        "terminal cleanup removes the sandbox and gateway",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "dashboard-remote-bind-runtime-info",
      scenarioLabel: "dashboard remote-bind",
    });

    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "dashboard-remote-bind-cleanup-gateway",
      env: testEnv(),
      redactionValues,
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${sandboxName}`, () =>
      sandbox.cleanupSandbox(sandboxName, {
        artifactName: "dashboard-remote-bind-cleanup-openshell-sandbox",
        env: testEnv(),
        redactionValues,
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, sandboxName, {
      artifactName: "dashboard-remote-bind-cleanup-nemoclaw-sandbox",
      env: testEnv(),
      redactionValues,
      timeoutMs: 120_000,
    });

    await host
      .command(process.execPath, [CLI_ENTRYPOINT, sandboxName, "destroy", "--yes"], {
        artifactName: "dashboard-remote-bind-preclean-nemoclaw-sandbox",
        env: testEnv(),
        timeoutMs: 120_000,
      })
      .catch(() => undefined);
    await sandbox
      .cleanupSandbox(sandboxName, {
        artifactName: "dashboard-remote-bind-preclean-openshell-sandbox",
        env: testEnv(),
        timeoutMs: 60_000,
      })
      .catch(() => undefined);
    await sandbox
      .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "dashboard-remote-bind-preclean-gateway",
        env: testEnv(),
        timeoutMs: 60_000,
      })
      .catch(() => undefined);

    progress.phase("install and onboard dashboard sandbox");
    const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
      artifactName: "dashboard-remote-bind-install",
      cwd: REPO_ROOT,
      env: testEnv({
        ...hosted.env,
        NVIDIA_INFERENCE_API_KEY: hosted.apiKey,
      }),
      redactionValues,
      timeoutMs: 25 * 60_000,
    });
    expect(install.exitCode, resultText(install)).toBe(0);

    const cliProbe = await host.command(
      "bash",
      [
        "-lc",
        'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; command -v nemoclaw; command -v openshell; nemoclaw --help >/dev/null',
      ],
      {
        artifactName: "dashboard-remote-bind-cli-probe",
        env: testEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(cliProbe.exitCode, `required CLI probe failed\n${resultText(cliProbe)}`).toBe(0);
    expect(cliProbe.stdout).toContain("nemoclaw");
    expect(cliProbe.stdout).toContain("openshell");

    progress.phase("stop sandbox and restart dashboard with remote binding");
    const stop = await host.nemoclaw([sandboxName, "stop"], {
      artifactName: "dashboard-remote-bind-stop-before-rebind",
      env: testEnv(),
      redactionValues,
      timeoutMs: 120_000,
    });
    expect(stop.exitCode, `Sandbox stop failed before remote rebind\n${resultText(stop)}`).toBe(0);
    expect(teardownSandboxDashboardForward(sandboxName)).toBe(true);

    const start = await host.nemoclaw([sandboxName, "start"], {
      artifactName: "dashboard-remote-bind-start-after-release",
      env: testEnv(),
      redactionValues,
      timeoutMs: 10 * 60_000,
    });
    expect(start.exitCode, `Sandbox start failed after remote rebind\n${resultText(start)}`).toBe(
      0,
    );

    progress.phase("verify all-interface dashboard forward");
    expect(isSandboxPortForwardHealthy(sandboxName, Number(dashboardPort), "0.0.0.0")).toBe(true);

    const forwardReachable = await host.command(
      process.execPath,
      [
        "-e",
        [
          'const net = require("node:net");',
          "const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });",
          "const deadline = setTimeout(() => { socket.destroy(); process.exit(1); }, 5000);",
          "socket.once('connect', () => { clearTimeout(deadline); socket.destroy(); process.exit(0); });",
          "socket.once('error', () => { clearTimeout(deadline); process.exit(1); });",
        ].join("\n"),
        remoteHost,
        dashboardPort,
      ],
      {
        artifactName: "dashboard-remote-bind-post-handoff-reachability",
        env: testEnv(),
        timeoutMs: 10_000,
      },
    );
    expect(
      forwardReachable.exitCode,
      `Dashboard forward is unreachable after connect handoff\n${resultText(forwardReachable)}`,
    ).toBe(0);

    progress.phase("audit exposed dashboard controls");
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
