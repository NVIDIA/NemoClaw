// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the supported boundaries: install.sh/onboard, OpenShell sandbox
 * stopped-phase recovery, native OpenClaw readiness, sandbox exec, and
 * durable /sandbox/.openclaw state markers.
 */

import fs from "node:fs";
import path from "node:path";

import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  cleanupWhenCommandAvailable,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import {
  assertExitZero,
  type HostCliClient,
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

async function waitForHostForwardReady(
  host: HostCliClient,
  artifactPrefix: string,
  gatewayPort: number,
): Promise<void> {
  await pollUntil({
    artifactPrefix,
    attempts: 30,
    delayMs: 5_000,
    probe: (_attempt, artifactName) =>
      host.command(
        "curl",
        [
          "-q",
          "--noproxy",
          "*",
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--connect-timeout",
          "2",
          "--max-time",
          "5",
          `http://127.0.0.1:${String(gatewayPort)}/health`,
        ],
        {
          artifactName,
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 10_000,
        },
      ),
    accept: (result) =>
      result.exitCode === 0 && (result.stdout.trim() === "200" || result.stdout.trim() === "401"),
  });
}

test(
  "sandbox recovers a running container left in OpenShell Stopped phase",
  {
    timeout: testTimeout(30 * 60_000),
    meta: {
      e2ePhases: [
        "confirm the selected runtime prerequisite",
        "install and register the OpenClaw sandbox",
        "write persistent OpenClaw markers",
        "create a running-container and OpenShell-Stopped mismatch",
        "recover the mismatch through nemoclaw recover",
        "recreate and repair the mismatch through nemoclaw start",
        "recheck native agent readiness, host-forward usability, and state",
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
        "OpenShell owns stopped-phase recovery even when Docker reports the container running",
        "nemoclaw recover and nemoclaw start independently repair that divergent state",
        "sandbox exec, the native OpenClaw gateway, and the host forward are usable after each repair",
        "declared workspace, session, and memory markers survive both recovery cycles",
        "final destroy removes the sandbox",
      ],
    });

    lifecycle.trackInstallerGatewayUserService();
    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info-sandbox-survival",
      scenarioLabel: "sandbox survival",
    });

    await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
      artifactName: "pre-cleanup-nemoclaw-destroy-sandbox-survival",
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
      artifactName: "cleanup-nemoclaw-destroy-sandbox-survival",
      redactionValues: [apiKey],
    };
    cleanup.trackSandbox(
      {
        cleanupSandbox: (name: string) =>
          cleanupWhenCommandAvailable(
            host,
            host.commandPath,
            {
              artifactName: "cleanup-probe-nemoclaw-sandbox-survival",
              env: buildAvailabilityProbeEnv(),
              redactionValues: sandboxCleanupOptions.redactionValues,
              timeoutMs: 30_000,
            },
            () => host.cleanupSandbox(name, sandboxCleanupOptions),
          ),
      },
      SANDBOX_NAME,
      sandboxCleanupOptions,
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

    const resourceHandle = await runtimeProvider.resolveSandboxResourceHandle(SANDBOX_NAME, {
      artifactName: "sandbox-survival-runtime-resource",
      timeoutMs: 30_000,
    });
    for (const command of ["recover", "start"] as const) {
      switch (command) {
        case "recover":
          progress.phase("create a running-container and OpenShell-Stopped mismatch");
          break;
        case "start":
          progress.phase("recreate and repair the mismatch through nemoclaw start");
          break;
      }
      const artifactPrefix = `${command}-mismatch`;
      const stop = await sandbox.openshell(["sandbox", "stop", "-g", "nemoclaw", SANDBOX_NAME], {
        artifactName: `${artifactPrefix}-openshell-stop`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      });
      assertExitZero(stop, `openshell sandbox stop before nemoclaw ${command}`);

      // Reproduce #11790: Docker restarts the container behind OpenShell's
      // lifecycle authority, leaving the container running while the phase
      // remains Stopped.
      const directStart = await runtimeProvider.command(["container", "start", resourceHandle], {
        artifactName: `${artifactPrefix}-runtime-start`,
        timeoutMs: 60_000,
      });
      assertExitZero(directStart, `${runtimeProvider.displayName} container start`);
      const phase = await sandbox.openshell(["sandbox", "get", "-g", "nemoclaw", SANDBOX_NAME], {
        artifactName: `${artifactPrefix}-openshell-stopped-phase`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      });
      assertExitZero(phase, "openshell sandbox get");
      expect(
        resultText(phase),
        `OpenShell did not retain the Stopped phase: ${resultText(phase)}`,
      ).toMatch(/\bPhase:\s*Stopped\b/u);

      const running = await runtimeProvider.command(
        ["container", "inspect", "--format", "{{.State.Running}}", resourceHandle],
        {
          artifactName: `${artifactPrefix}-runtime-running`,
          timeoutMs: 30_000,
        },
      );
      assertExitZero(running, `${runtimeProvider.displayName} container inspect`);
      expect(
        running.stdout.trim(),
        `${runtimeProvider.displayName} did not report the sandbox container running`,
      ).toBe("true");

      if (command === "recover") {
        progress.phase("recover the mismatch through nemoclaw recover");
      }
      const lifecycleRepair = await host.nemoclaw([SANDBOX_NAME, command], {
        artifactName: `nemoclaw-${command}-running-stopped-mismatch`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 180_000,
      });
      assertExitZero(lifecycleRepair, `nemoclaw ${SANDBOX_NAME} ${command}`);
      switch (command) {
        case "recover":
          break;
        case "start":
          progress.phase("recheck native agent readiness, host-forward usability, and state");
          break;
      }

      await lifecycle.assertSandboxReadyAfterGatewayRestart(instance, {
        artifactNamePrefix: `post-${command}-openshell-ready`,
      });
      expect(
        await runtimeProvider.resolveSandboxResourceHandle(SANDBOX_NAME, {
          artifactName: `post-${command}-sandbox-container`,
          timeoutMs: 30_000,
        }),
        `${command} must preserve the sandbox container identity`,
      ).toBe(resourceHandle);
      await expectSandboxExecAlive(SANDBOX_NAME, execShell, `post-${command}-sandbox-exec-alive`);
      await waitForNativeAgentReady(
        execShell,
        `post-${command}-native-agent-ready`,
        DASHBOARD_PORT,
      );
      await waitForHostForwardReady(host, `post-${command}-host-forward-ready`, DASHBOARD_PORT);
      await stateValidation.expectSandboxMarkers(instance, markers, `post-${command}-marker-read`);
    }

    progress.phase("destroy the sandbox");
    await host.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "final-destroy-sandbox-survival",
      timeoutMs: 15 * 60_000,
    });
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
        recoverReconciledRunningStoppedMismatch: true,
        startReconciledRunningStoppedMismatch: true,
        nativeAgentReadyBeforeStop: true,
        deliveryPathReadyAfterRecover: true,
        markersPersistedAfterBothRepairs: true,
        deliveryPathReadyAfterStart: true,
        destroyedAtEnd,
      },
    });
  },
);
