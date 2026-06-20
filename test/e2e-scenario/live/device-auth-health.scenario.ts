// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-device-auth-health.sh.
 *
 * Preserves the legacy #2342 contract with real install/onboard, sandbox HTTP
 * probes, `nemoclaw status`, host port-forward checks, and gateway recovery:
 * device-auth 401 responses must not be misreported as Health Offline.
 */

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-health-auth";
validateSandboxName(SANDBOX_NAME);
const DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789";
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;
const LIVE_TIMEOUT_MS = 30 * 60_000;

function commandEnv(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_DASHBOARD_PORT: DASHBOARD_PORT,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  if (apiKey) {
    env.NVIDIA_INFERENCE_API_KEY = apiKey;
    env.NVIDIA_API_KEY = apiKey;
  }
  return env;
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort cleanup/recovery probes should not hide primary failures.
  }
}

function assertStatusNotOffline(output: string, context: string): void {
  expect(output, `${context} must not report the #2342 false Health Offline state`).not.toMatch(
    /offline/i,
  );
}

async function httpCodeFromSandbox(
  sandbox: SandboxClient,
  urlPath: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `curl -so /dev/null -w '%{http_code}' --max-time 3 http://localhost:${DASHBOARD_PORT}${urlPath}`,
    ),
    {
      artifactName,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "device auth health probes treat 401 as live instead of offline (#2342)",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const installLog = artifacts.pathFor("phase-1-install-device-auth-health.log");

    await artifacts.writeJson("scenario.json", {
      id: "device-auth-health",
      runner: "vitest",
      legacySource: "test/e2e/test-device-auth-health.sh",
      boundary: "install.sh + OpenShell sandbox exec + NemoClaw status + host curl",
      sandboxName: SANDBOX_NAME,
      dashboardPort: DASHBOARD_PORT,
      contracts: [
        "onboard succeeds with device auth enabled",
        "/health is reachable from inside the sandbox",
        "the authenticated dashboard root may return 401 without being treated as offline",
        "nemoclaw status reports the gateway as live, not Health Offline",
        "status remains non-offline after a gateway kill/recovery attempt",
      ],
    });

    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for device auth health E2E: ${resultText(dockerInfo)}`);
      }
      skip(`Docker is required for device auth health E2E: ${resultText(dockerInfo)}`);
    }

    cleanup.add(`destroy device-auth sandbox ${SANDBOX_NAME}`, async () => {
      await bestEffort(() =>
        host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-device-auth-health",
          env: commandEnv(),
          timeoutMs: 120_000,
        }),
      );
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-delete-device-auth-health",
          env: commandEnv(),
          timeoutMs: 60_000,
        }),
      );
    });

    await bestEffort(() =>
      host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-device-auth-health",
        env: commandEnv(),
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-delete-device-auth-health",
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );

    let install: ShellProbeResult | undefined;
    for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
      install = await host.command("bash", ["install.sh", "--non-interactive"], {
        artifactName:
          attempt === 1
            ? "phase-1-install-device-auth-health"
            : `phase-1-install-device-auth-health-attempt-${attempt}`,
        cwd: REPO_ROOT,
        env: commandEnv(apiKey),
        redactionValues: [apiKey],
        timeoutMs: 20 * 60_000,
      });
      fs.writeFileSync(installLog, resultText(install));
      if (install.exitCode === 0) break;
      if (isTransientProviderValidationFailure(install) && attempt < INSTALL_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
        continue;
      }
      break;
    }
    expect(install, "install command must run").toBeDefined();
    expect(install?.exitCode, resultText(install as ShellProbeResult)).toBe(0);

    await host.expectListed(SANDBOX_NAME, {
      artifactName: "phase-1-nemoclaw-list-device-auth-health",
      env: commandEnv(),
      timeoutMs: 60_000,
    });

    const health = await httpCodeFromSandbox(sandbox, "/health", "phase-2-sandbox-health-code");
    expect(health.exitCode, resultText(health)).toBe(0);
    expect(health.stdout.trim()).toBe("200");

    const root = await httpCodeFromSandbox(sandbox, "/", "phase-2-sandbox-root-code");
    expect(root.exitCode, resultText(root)).toBe(0);
    expect(["200", "401"], `dashboard root returned ${root.stdout.trim()}`).toContain(
      root.stdout.trim(),
    );

    const status = await host.nemoclaw([SANDBOX_NAME, "status"], {
      artifactName: "phase-3-nemoclaw-status-device-auth-health",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    expect(status.exitCode, resultText(status)).toBe(0);
    assertStatusNotOffline(resultText(status), "initial status");
    expect(resultText(status)).toMatch(/running|online|healthy|OpenClaw|Ready/i);

    const hostHealth = await host.command(
      "curl",
      [
        "-so",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        `http://127.0.0.1:${DASHBOARD_PORT}/health`,
      ],
      {
        artifactName: "phase-4-host-health-code",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    if (hostHealth.stdout.trim() && hostHealth.stdout.trim() !== "000") {
      expect(
        ["200", "401"],
        `host dashboard health returned ${hostHealth.stdout.trim()}`,
      ).toContain(hostHealth.stdout.trim());
    }

    await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript("pkill -f 'openclaw.*gateway' 2>/dev/null || true"),
      {
        artifactName: "phase-5-kill-gateway-process",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const recoveryStatus = await host.nemoclaw([SANDBOX_NAME, "status"], {
      artifactName: "phase-5-nemoclaw-status-after-gateway-kill",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    expect(recoveryStatus.exitCode, resultText(recoveryStatus)).toBe(0);
    assertStatusNotOffline(resultText(recoveryStatus), "recovery status");

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const recoveredHealth = await httpCodeFromSandbox(
        sandbox,
        "/health",
        `phase-5-recovery-health-code-attempt-${attempt}`,
      );
      const code = recoveredHealth.stdout.trim();
      if (code === "200" || code === "401") {
        await artifacts.writeJson("gateway-recovered.json", { attempt, code });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    await artifacts.writeJson("gateway-recovery-inconclusive.json", {
      reason: "Gateway did not recover within 150s; legacy shell treated this as optional.",
    });
  },
);
