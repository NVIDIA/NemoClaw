// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  assertNvidiaAvailable,
  cleanupGpu,
  cleanupOllama,
  ensureOllama,
  env,
  REPO_ROOT,
  SANDBOX_NAME,
} from "./gpu-e2e-helpers.ts";
import { assertHermesFollowUpReplies } from "./hermes-cli-adapter-live.ts";

const TIMEOUT_MS = 90 * 60_000;

function hermesEnv(): NodeJS.ProcessEnv {
  return env({
    NEMOCLAW_AGENT: "hermes",
    NEMOCLAW_CONTEXT_WINDOW: "65536",
  });
}

test(
  "Hermes returns conversational replies for new, resumed, and continued GPU Ollama sessions (#10215)",
  {
    timeout: TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare clean GPU Ollama runtime",
        "install Hermes with local Ollama inference",
        "run Hermes initial, resumed, and continued replies",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
    await artifacts.target.declare({
      id: "gpu-hermes-response-validation",
      boundary: "Hermes sandbox + GPU Ollama + initial, resumed, and continued CLI replies",
      sandboxName: SANDBOX_NAME,
      expectedReplies: ["acknowledged", "56", "56"],
    });

    const cleanupEnv = hermesEnv();
    cleanup.trackDisposable("stop Hermes response-validation Ollama processes", async () => {
      const result = await cleanupOllama(host, "cleanup-hermes-response-ollama-processes");
      expect(result.exitCode, resultText(result)).toBe(0);
    });
    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-hermes-response-gateway",
      env: cleanupEnv,
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-hermes-response-openshell-sandbox",
        env: cleanupEnv,
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-hermes-response-sandbox",
      env: cleanupEnv,
      timeoutMs: 120_000,
    });
    progress.phase("prepare clean GPU Ollama runtime");
    await cleanupGpu(host, sandbox);

    const docker = await host.command("docker", ["info"], {
      artifactName: "docker-info-hermes-response",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);
    const nvidia = await host.command("nvidia-smi", [], {
      artifactName: "nvidia-smi-hermes-response",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    assertNvidiaAvailable(nvidia, skip);

    await ensureOllama(host);
    const ollamaCleanup = await cleanupOllama(host, "pre-cleanup-hermes-response-ollama");
    expect(ollamaCleanup.exitCode, resultText(ollamaCleanup)).toBe(0);

    progress.phase("install Hermes with local Ollama inference");
    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--fresh", "--yes-i-accept-third-party-software"],
      {
        artifactName: "install-gpu-hermes-ollama",
        cwd: REPO_ROOT,
        env: hermesEnv(),
        timeoutMs: 60 * 60_000,
      },
    );
    expect(install.exitCode, resultText(install)).toBe(0);

    progress.phase("run Hermes initial, resumed, and continued replies");
    await assertHermesFollowUpReplies({
      env: hermesEnv(),
      redactionValues: [],
      sandbox,
      sandboxName: SANDBOX_NAME,
    });
  },
);
