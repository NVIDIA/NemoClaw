// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

// Focused Vitest live replacement for
// test/e2e/test-model-router-provider-routed-inference.sh. Keep this as a
// direct CLI/sandbox test: the legacy contract is the real provider-routed
// onboard boundary plus host model-router health and sandbox inference.local
// completion semantics, not a new scenario registry entry.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-model-router";
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const HEALTH_ATTEMPTS = 20;
const COMPLETION_ATTEMPTS = 3;

interface ModelRouterHealth {
  healthy_count?: unknown;
}

interface ChatCompletionResponse {
  model?: unknown;
  choices?: Array<{
    message?: { content?: unknown };
    text?: unknown;
  }>;
}

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function hasHealthyEndpoint(raw: string): boolean {
  const health = parseJson<ModelRouterHealth>(raw);
  return typeof health?.healthy_count === "number" && health.healthy_count > 0;
}

function routedPongReason(raw: string): "ok" | string {
  const response = parseJson<ChatCompletionResponse>(raw);
  if (!response) return "response was not JSON";
  const model = String(response.model ?? "");
  if (model !== "nvidia-routed" && !model.startsWith("nvidia-routed")) {
    return "response model was not provider-routed";
  }
  const content = (response.choices ?? [])
    .map((choice) => {
      if (typeof choice.message?.content === "string") return choice.message.content;
      if (typeof choice.text === "string") return choice.text;
      return "";
    })
    .join("\n");
  if (!/\bPONG\b/i.test(content)) return "response missing PONG content";
  return "ok";
}

function withProviderRoutedEnv(apiKey: string): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NVIDIA_INFERENCE_API_KEY: apiKey,
    NEMOCLAW_PROVIDER_KEY: apiKey,
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_POLICY_TIER: "open",
    NEMOCLAW_PROVIDER: "routed",
  };
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "model-router provider-routed onboard returns routed inference.local PONG",
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-model-router-provider-routed",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for provider-routed Model Router onboarding: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for provider-routed Model Router onboarding");
    }

    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_INFERENCE_API_KEY must start with nvapi-").toBe(
      true,
    );

    await artifacts.writeJson("scenario.json", {
      id: "model-router-provider-routed-inference",
      runner: "vitest",
      boundary: "direct-cli-onboard-and-sandbox-exec",
      legacySource: "test/e2e/test-model-router-provider-routed-inference.sh",
      contract: [
        "Docker is available before onboarding",
        "NVIDIA_INFERENCE_API_KEY is present and nvapi-prefixed",
        "nemoclaw onboard --fresh completes with NEMOCLAW_PROVIDER=routed",
        "host model-router health reports at least one healthy endpoint",
        "sandbox inference.local returns model nvidia-routed with PONG content",
      ],
    });

    const cleanEnv = buildAvailabilityProbeEnv();
    await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy-model-router-provider-routed",
      env: cleanEnv,
      timeoutMs: 120_000,
    });

    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "cleanup-nemoclaw-destroy-model-router-provider-routed",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      });
    });

    const onboard = await host.command(
      "node",
      [
        CLI_ENTRYPOINT,
        "onboard",
        "--fresh",
        "--non-interactive",
        "--yes-i-accept-third-party-software",
      ],
      {
        artifactName: "onboard-model-router-provider-routed",
        env: withProviderRoutedEnv(apiKey),
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);

    let lastHealth = "";
    for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
      const health = await host.command(
        "curl",
        ["-s", "--max-time", "10", "http://127.0.0.1:4000/health"],
        {
          artifactName: `model-router-health-${attempt}`,
          env: buildAvailabilityProbeEnv(),
          redactionValues: [apiKey],
          timeoutMs: 15_000,
        },
      );
      lastHealth = health.stdout || health.stderr;
      if (health.exitCode === 0 && hasHealthyEndpoint(lastHealth)) break;
      if (attempt < HEALTH_ATTEMPTS) await sleep(3_000);
    }
    expect(
      hasHealthyEndpoint(lastHealth),
      `model-router has no healthy endpoints; expected #3255 main-equivalent failure: ${lastHealth.slice(0, 500)}`,
    ).toBe(true);

    const payload = JSON.stringify({
      model: "nvidia-routed",
      messages: [
        {
          role: "user",
          content: "Return only the exact word PONG. Do not include reasoning or any other text.",
        },
      ],
      max_tokens: 128,
    });
    let lastCompletion = "";
    let completionReason = "not attempted";
    for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt += 1) {
      const completion = await sandbox.exec(
        SANDBOX_NAME,
        [
          "curl",
          "-sk",
          "--max-time",
          "90",
          "https://inference.local/v1/chat/completions",
          "-H",
          "Content-Type: application/json",
          "--data-raw",
          payload,
        ],
        {
          artifactName: `sandbox-inference-local-routed-completion-${attempt}`,
          env: buildAvailabilityProbeEnv(),
          redactionValues: [apiKey],
          timeoutMs: 120_000,
        },
      );
      lastCompletion = completion.stdout || completion.stderr;
      completionReason = routedPongReason(lastCompletion);
      if (completion.exitCode === 0 && completionReason === "ok") break;
      if (/inference service unavailable|HTTP 503|healthy_count.*0/i.test(lastCompletion)) break;
      if (attempt < COMPLETION_ATTEMPTS) await sleep(5_000);
    }
    expect(
      completionReason,
      `Model Router inference.local did not return a routed completion; expected #3255 main-equivalent failure: ${lastCompletion.slice(0, 500)}`,
    ).toBe("ok");

    await artifacts.writeJson("scenario-result.json", {
      id: "model-router-provider-routed-inference",
      assertions: {
        dockerRunning: docker.exitCode === 0,
        onboardCompleted: onboard.exitCode === 0,
        modelRouterHealthy: hasHealthyEndpoint(lastHealth),
        routedPongCompletion: completionReason === "ok",
      },
    });
  },
);
