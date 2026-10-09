// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requirePublicNvidiaInferenceKey } from "../fixtures/inference-adapter.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { buildProviderRoutedEnv } from "./model-router-provider-routed-inference-helpers.ts";

// Focused direct CLI/sandbox test: the contract is the real provider-routed
// onboard boundary plus one ordinary sandbox inference.local completion.

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-model-router";
const ONBOARD_TIMEOUT_MS = execTimeout(25 * 60_000);

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

test(
  "model-router provider-routed onboard returns an inference.local completion",
  {
    meta: {
      e2ePhases: [
        "confirm routed-provider prerequisites",
        "clear the previous routed-provider sandbox",
        "onboard the routed provider",
        "request a routed inference.local completion",
        "record the routed inference contract result",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtime, runtimeProvider, secrets }) => {
    progress.phase("confirm routed-provider prerequisites");
    await runtimeProvider.requireAvailable({
      artifactName: "prereq-runtime-info-model-router-provider-routed",
      scenarioLabel: "provider-routed Model Router onboarding",
    });

    const apiKey = requirePublicNvidiaInferenceKey(secrets.required("NVIDIA_API_KEY"));

    await artifacts.target.declare({
      id: "model-router-provider-routed-inference",
      boundary: "direct-cli-onboard-and-sandbox-exec",
      contract: [
        "the selected runtime is available before onboarding",
        "NVIDIA_API_KEY is present and nvapi-prefixed, then staged for the router's NVIDIA_INFERENCE_API_KEY credential",
        "nemoclaw onboard --fresh completes with NEMOCLAW_PROVIDER=routed",
        "sandbox inference.local returns a valid chat completion through the routed provider",
      ],
    });

    progress.phase("clear the previous routed-provider sandbox");
    await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy-model-router-provider-routed",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });

    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy-model-router-provider-routed",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });

    progress.phase("onboard the routed provider");
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
        env: buildProviderRoutedEnv(apiKey, SANDBOX_NAME),
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);

    progress.phase("request a routed inference.local completion");
    await runtime.expectInferenceLocalChatCompletion(
      { sandboxName: SANDBOX_NAME },
      {
        artifactName: "sandbox-inference-local-routed-completion",
        curlMaxTimeSeconds: 90,
        maxTokens: 128,
        model: "nvidia-routed",
        prompt: "Reply with a short greeting.",
        redactionValues: [apiKey],
        timeoutMs: 120_000,
      },
    );

    progress.phase("record the routed inference contract result");
    await artifacts.target.complete({
      id: "model-router-provider-routed-inference",
      assertions: {
        runtimeProviderAvailable: true,
        onboardCompleted: true,
        validCompletionReturned: true,
      },
    });
  },
);
