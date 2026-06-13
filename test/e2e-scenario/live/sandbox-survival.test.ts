// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-sandbox-survival.sh.
 *
 * Preserves the legacy real boundaries: install.sh/onboard, Docker, OpenShell
 * gateway stop/start, NemoClaw registry/list/status, sandbox SSH/exec, durable
 * /sandbox/.openclaw state markers, and inference.local chat completion before
 * and after gateway restart.
 */

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText, sandboxAccessEnv } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { NemoClawInstance } from "../fixtures/phases/index.ts";
import type { SandboxMarker } from "../fixtures/phases/state-validation.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-survival";
const MIN_OPENSHELL_VERSION = "0.0.24";
const MODEL = process.env.NEMOCLAW_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function versionGte(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map((part) => Number.parseInt(part, 10));
  const minimumParts = minimum.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const a = Number.isFinite(actualParts[index]) ? actualParts[index] : 0;
    const b = Number.isFinite(minimumParts[index]) ? minimumParts[index] : 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function extractSemver(raw: string): string | undefined {
  return raw.match(/\d+\.\d+\.\d+/)?.[0];
}

function installEnv(apiKey: string): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NVIDIA_INFERENCE_API_KEY: apiKey,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_PROVIDER: "cloud",
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

test.skipIf(!shouldRunLiveE2EScenarios())(
  "sandbox survives gateway restart with registry, state, SSH, and live inference intact",
  async ({
    artifacts,
    cleanup,
    host,
    lifecycle,
    runtime,
    sandbox,
    secrets,
    skip,
    stateValidation,
  }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_INFERENCE_API_KEY must start with nvapi-").toBe(
      true,
    );

    await artifacts.writeJson("scenario.json", {
      id: "sandbox-survival",
      runner: "vitest",
      boundary: "install-sh-docker-openshell-gateway-sandbox-inference",
      legacySource: "test/e2e/test-sandbox-survival.sh",
      contracts: [
        "install.sh --non-interactive creates the named OpenClaw sandbox",
        "NemoClaw registry, nemoclaw list/status, and openshell sandbox list discover the sandbox",
        "OpenShell version supports gateway resume and state persistence",
        "sandbox exec/SSH-equivalent access works before and after gateway restart",
        "inference.local returns a live PONG before and after gateway restart",
        "markers under /sandbox/.openclaw survive the gateway stop/start cycle",
        "final destroy removes the sandbox from NemoClaw registry/list state",
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-sandbox-survival",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(`Docker is required for sandbox survival E2E: ${resultText(docker)}`);
      }
      skip("Docker is required for sandbox survival E2E");
    }

    const modelsReachable = await host.command(
      "curl",
      ["-sf", "--max-time", "10", "https://inference-api.nvidia.com/v1/models"],
      {
        artifactName: "prereq-inference-api-models",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 15_000,
      },
    );
    expect(modelsReachable.exitCode, resultText(modelsReachable)).toBe(0);
    expect(fs.existsSync(path.join(REPO_ROOT, "install.sh"))).toBe(true);

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

    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-nemoclaw-destroy-sandbox-survival",
      });
    });
    cleanup.add("destroy shared NemoClaw gateway", async () => {
      await host.command(
        "sh",
        [
          "-lc",
          "command -v openshell >/dev/null 2>&1 && openshell gateway destroy -g nemoclaw || true",
        ],
        {
          artifactName: "cleanup-openshell-gateway-destroy",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 120_000,
        },
      );
    });

    const install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName: "install-sh-sandbox-survival",
      cwd: REPO_ROOT,
      env: installEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: 20 * 60_000,
    });
    expect(install.exitCode, resultText(install)).toBe(0);

    await host.expectNemoclawAvailable();
    const openshellVersion = await host.command("openshell", ["--version"], {
      artifactName: "openshell-version-sandbox-survival",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    assertExitZero(openshellVersion, "openshell --version");
    const version = extractSemver(resultText(openshellVersion));
    expect(version, resultText(openshellVersion)).toBeTruthy();
    expect(versionGte(version!, MIN_OPENSHELL_VERSION), resultText(openshellVersion)).toBe(true);

    const instance: NemoClawInstance = {
      onboarding: "cloud-openclaw",
      sandboxName: SANDBOX_NAME,
      agent: "openclaw",
      provider: "nvidia",
      providerEnv: "cloud",
      platformOs: "ubuntu",
      gatewayUrl: "http://127.0.0.1:18789",
      result: install,
    };

    stateValidation.expectLocalRegistryContains(SANDBOX_NAME);
    await host.expectListed(SANDBOX_NAME, {
      artifactName: "post-install-nemoclaw-list",
    });
    await sandbox.expectListed(SANDBOX_NAME, {
      artifactName: "post-install-openshell-sandbox-list",
    });
    await host.expectStatus(SANDBOX_NAME, {
      artifactName: "post-install-nemoclaw-status",
    });

    const execShell = (script: string, artifactName: string) =>
      sandbox.exec(SANDBOX_NAME, ["sh", "-lc", script], {
        artifactName,
        env: sandboxAccessEnv(),
        timeoutMs: 60_000,
      });
    await expectSandboxExecAlive(SANDBOX_NAME, execShell, "baseline-sandbox-exec-alive");

    await runtime.expectInferenceLocalPong(instance, {
      artifactName: "baseline-inference-local-pong",
      model: MODEL,
      curlMaxTimeSeconds: 60,
      timeoutMs: 90_000,
      redactionValues: [apiKey],
    });

    const markerValue = `nemoclaw-survival-${Date.now()}`;
    const markers: SandboxMarker[] = [
      {
        path: "/sandbox/.openclaw/.survival-marker-workspace",
        value: markerValue,
      },
      { path: "/sandbox/.openclaw/.survival-marker", value: markerValue },
      {
        path: "/sandbox/.openclaw/test-data/nested-marker.txt",
        value: markerValue,
      },
    ];
    await stateValidation.writeSandboxMarkers(instance, markers);
    await stateValidation.expectSandboxMarkers(instance, markers, "pre-restart-marker-read");

    await lifecycle.restartGatewayRuntime({
      delayMs: 5_000,
      sandboxName: SANDBOX_NAME,
    });
    await lifecycle.waitForGatewayConnected({
      attempts: 60,
      intervalMs: 5_000,
    });

    await sandbox.expectListed(SANDBOX_NAME, {
      artifactName: "post-restart-openshell-sandbox-list",
    });
    stateValidation.expectLocalRegistryContains(SANDBOX_NAME);
    await host.expectListed(SANDBOX_NAME, {
      artifactName: "post-restart-nemoclaw-list",
    });
    await host.expectStatus(SANDBOX_NAME, {
      artifactName: "post-restart-nemoclaw-status",
      timeoutMs: 120_000,
    });
    await expectSandboxExecAlive(SANDBOX_NAME, execShell, "post-restart-sandbox-exec-alive");
    await stateValidation.expectSandboxMarkers(instance, markers, "post-restart-marker-read");
    await stateValidation.expectSandboxDirectoryPopulated(
      instance,
      "/sandbox/.openclaw",
      "post-restart-openclaw-directory-populated",
    );

    await runtime.expectInferenceLocalPong(instance, {
      artifactName: "post-restart-inference-local-pong",
      model: MODEL,
      curlMaxTimeSeconds: 60,
      timeoutMs: 90_000,
      redactionValues: [apiKey],
    });

    await host.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "final-destroy-sandbox-survival",
      timeoutMs: 15 * 60_000,
    });
    const afterDestroyList = await host.nemoclaw(["list"], {
      artifactName: "post-destroy-nemoclaw-list",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    expect(resultText(afterDestroyList), "sandbox still listed after destroy").not.toMatch(
      new RegExp(`(^|\\s)${SANDBOX_NAME}(\\s|$)`, "m"),
    );

    await artifacts.writeJson("scenario-result.json", {
      id: "sandbox-survival",
      status: "passed",
      legacySource: "test/e2e/test-sandbox-survival.sh",
      assertions: {
        installCompleted: install.exitCode === 0,
        registryListedBeforeRestart: true,
        inferenceLocalBeforeRestart: true,
        markersPersistedAfterRestart: true,
        inferenceLocalAfterRestart: true,
        destroyedAtEnd: true,
      },
    });
  },
  30 * 60_000,
);
