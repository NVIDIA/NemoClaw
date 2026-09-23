// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the supported boundaries: install.sh/onboard, OpenShell sandbox
 * OpenShell stop/start, native OpenClaw readiness, sandbox exec, and
 * durable /sandbox/.openclaw state markers.
 */

import fs from "node:fs";
import path from "node:path";

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { cleanupWhenOpenShellAvailable } from "../fixtures/cleanup-resources.ts";
import {
  assertExitZero,
  outputContainsSandbox,
  resultText,
  sandboxAccessEnv,
} from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { NemoClawInstance } from "../fixtures/phases/index.ts";
import type { SandboxMarker } from "../fixtures/phases/state-validation.ts";
import { pollUntil } from "../fixtures/polling.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-survival";
const DASHBOARD_PORT = Number(process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789");

function installEnv(hostedEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...hostedEnv,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_DASHBOARD_PORT: String(DASHBOARD_PORT),
  };
}

async function expectSandboxExecAlive(
  sandboxName: string,
  exec: (
    script: string,
    artifactName: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>,
  artifactName: string,
): Promise<void> {
  const alive = await exec("echo alive", artifactName);
  expect(alive.exitCode, `${sandboxName} exec failed: ${resultText(alive)}`).toBe(0);
  expect(alive.stdout.trim(), resultText(alive)).toBe("alive");
}

async function waitForNativeAgentReady(
  exec: (
    script: string,
    artifactName: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>,
  artifactPrefix: string,
  gatewayPort: number,
): Promise<void> {
  await pollUntil({
    artifactPrefix,
    attempts: 30,
    delayMs: 5_000,
    probe: (_attempt, artifactName) =>
      exec(
        `code="$(curl -q --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 http://127.0.0.1:${String(gatewayPort)}/health)"; case "$code" in 200|401) printf '%s\\n' ready ;; *) exit 1 ;; esac`,
        artifactName,
      ),
    accept: (result) => result.exitCode === 0 && result.stdout.trim() === "ready",
  });
}

test(
  "OpenShell stop/start preserves native agent state",
  {
    timeout: testTimeout(30 * 60_000),
    meta: {
      e2ePhases: [
        "confirm the selected runtime prerequisite",
        "install and register the OpenClaw sandbox",
        "write persistent OpenClaw markers",
        "stop the sandbox through OpenShell",
        "start the sandbox through OpenShell",
        "recheck native agent readiness and state",
        "destroy the sandbox",
      ],
    },
  },
  async ({
    artifacts,
    cleanup,
    host,
    lifecycle,
    progress,
    runtimeProvider,
    sandbox,
    secrets,
    skip,
    stateValidation,
  }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const apiKey = hosted.apiKey;

    await artifacts.target.declare({
      id: "sandbox-survival",
      boundary: "install-sh-openshell-sandbox-native-agent-state",
      contracts: [
        "install.sh --non-interactive creates the named OpenClaw sandbox",
        "OpenShell owns sandbox stop and start",
        "sandbox exec and the native OpenClaw gateway are usable after restart",
        "declared workspace, session, and memory markers survive the OpenShell lifecycle",
        "final destroy removes the sandbox",
      ],
    });

    lifecycle.trackInstallerGatewayUserService();
    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info-sandbox-survival",
      scenarioLabel: "sandbox survival",
    });

    await host.command(
      "sh",
      [
        "-lc",
        `command -v openshell >/dev/null 2>&1 && openshell sandbox delete ${SANDBOX_NAME} || true`,
      ],
      {
        artifactName: "pre-cleanup-openshell-delete-sandbox-survival",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    await lifecycle.stopGatewayRuntime();
    await host.command(
      "sh",
      [
        "-lc",
        "command -v openshell >/dev/null 2>&1 && openshell gateway destroy -g nemoclaw || true",
      ],
      {
        artifactName: "pre-cleanup-openshell-gateway-destroy",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    fs.rmSync(path.join(process.env.HOME ?? "", ".nemoclaw", "onboard.lock"), {
      force: true,
    });

    const gatewayCleanupOptions = {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    };
    cleanup.trackGateway(
      {
        cleanupGatewayRegistration: (name: string) =>
          cleanupWhenOpenShellAvailable(
            host,
            {
              artifactName: "cleanup-probe-openshell-gateway-sandbox-survival",
              env: gatewayCleanupOptions.env,
              redactionValues: gatewayCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
          ),
      },
      "nemoclaw",
      gatewayCleanupOptions,
    );
    const sandboxCleanupOptions = {
      artifactName: "cleanup-openshell-delete-sandbox-survival",
      redactionValues: [apiKey],
    };
    let sandboxDeleted = false;
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandboxDeleted
        ? Promise.resolve()
        : cleanupWhenOpenShellAvailable(
            host,
            {
              artifactName: "cleanup-probe-openshell-sandbox-survival",
              env: buildAvailabilityProbeEnv(),
              redactionValues: sandboxCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => sandbox.cleanupSandbox(SANDBOX_NAME, sandboxCleanupOptions),
          ),
    );

    progress.phase("install and register the OpenClaw sandbox");
    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "install-sh-sandbox-survival",
      cwd: REPO_ROOT,
      env: installEnv(hosted.env),
      redactionValues: [apiKey],
      timeoutMs: execTimeout(20 * 60_000),
    });
    expect(install.exitCode, resultText(install)).toBe(0);

    const instance: NemoClawInstance = {
      onboarding: "cloud-openclaw",
      sandboxName: SANDBOX_NAME,
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      platformOs: "ubuntu",
      gatewayUrl: `http://127.0.0.1:${String(DASHBOARD_PORT)}`,
      result: install,
    };

    stateValidation.expectLocalRegistryContains(SANDBOX_NAME);
    const execShell = (script: string, artifactName: string) =>
      sandbox.exec(SANDBOX_NAME, ["sh", "-lc", script], {
        artifactName,
        env: sandboxAccessEnv(),
        timeoutMs: 60_000,
      });

    progress.phase("write persistent OpenClaw markers");
    const markerValue = `nemoclaw-survival-${Date.now()}`;
    const markers: SandboxMarker[] = [
      {
        path: "/sandbox/.openclaw/workspace/.survival-workspace-marker",
        value: markerValue,
      },
      {
        path: "/sandbox/.openclaw/agents/main/sessions/.survival-session-marker",
        value: markerValue,
      },
      {
        path: "/sandbox/.openclaw/memory/.survival-memory-marker",
        value: markerValue,
      },
    ];
    await stateValidation.writeSandboxMarkers(instance, markers);
    await stateValidation.expectSandboxMarkers(instance, markers, "pre-restart-marker-read");

    progress.phase("stop the sandbox through OpenShell");
    const stop = await sandbox.openshell(["sandbox", "stop", "-g", "nemoclaw", SANDBOX_NAME], {
      artifactName: "openshell-stop-sandbox-survival",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });
    assertExitZero(stop, "OpenShell sandbox stop");

    progress.phase("start the sandbox through OpenShell");
    const start = await sandbox.openshell(["sandbox", "start", "-g", "nemoclaw", SANDBOX_NAME], {
      artifactName: "openshell-start-sandbox-survival",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });
    assertExitZero(start, "OpenShell sandbox start");

    progress.phase("recheck native agent readiness and state");
    await lifecycle.waitForSandboxReadyAfterGatewayRestart(instance, {
      artifactNamePrefix: "post-openshell-start-ready",
    });
    await expectSandboxExecAlive(SANDBOX_NAME, execShell, "post-openshell-start-sandbox-exec");
    await waitForNativeAgentReady(execShell, "post-openshell-start-native-ready", DASHBOARD_PORT);
    await stateValidation.expectSandboxMarkers(
      instance,
      markers,
      "post-openshell-start-marker-read",
    );

    progress.phase("destroy the sandbox");
    await sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "final-openshell-delete-sandbox-survival",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });
    sandboxDeleted = true;
    const postDestroyList = await sandbox.list({
      artifactName: "post-destroy-openshell-sandbox-list",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    assertExitZero(postDestroyList, "openshell sandbox list after destroy");
    const destroyedAtEnd = !outputContainsSandbox(postDestroyList, SANDBOX_NAME);
    expect(destroyedAtEnd, "sandbox remained listed after destroy").toBe(true);

    await artifacts.target.complete({
      id: "sandbox-survival",
      status: "passed",
      assertions: {
        installCompleted: install.exitCode === 0,
        openshellStopStartCompleted: true,
        nativeAgentReadyBeforeStop: true,
        markersPersistedAfterBothRepairs: true,
        deliveryPathReadyAfterStart: true,
        destroyedAtEnd,
      },
    });
  },
);
