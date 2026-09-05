// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { useOpenAiValidationTestServers } from "../inference/openai-validation-session.test-helpers";
import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";

const EXPECTED_WSL_SLOW_VERIFICATION_ADVISORY =
  "WSL2 detected — network verification may be slower than expected. " +
  "Check proxy and VPN health, then run onboarding again with a longer budget: " +
  "`NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS=360 nemoclaw onboard`.";
const resumableValidationExit = {
  code: 1,
  name: "OnboardDeferredExitError",
  preserveIncompleteSession: true,
};
const listen = useOpenAiValidationTestServers();

describe("default inference selection validation probe", () => {
  it("carries a WSL timeout through non-interactive teardown (#10413)", async () => {
    let requests = 0;
    const replyPlan = [
      (response: http.ServerResponse) => {
        response.setHeader("content-type", "application/json");
        response.end(
          '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"Planning the tool call."}}]}',
        );
      },
    ];
    const holdOpen = () => {};
    const server = http.createServer((request, response) => {
      request.resume();
      const reply = replyPlan[requests] ?? holdOpen;
      requests += 1;
      reply(response);
    });
    const port = await listen(server);
    const originalExitCode = process.exitCode;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const teardownOrphanManagedGatewayOnAbort = vi.fn(() => true);
    const legacySpawn = vi.fn(() => {
      throw new Error("unexpected legacy probe");
    });
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => true,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      teardownOrphanManagedGatewayOnAbort,
      promptValidationRecovery,
    });
    const probeOptions = {
      skipResponsesProbe: true,
      requireChatCompletionsToolCalling: true,
      isWsl: true,
      spawnSyncImpl: legacySpawn,
      validationTiming: {
        connectTimeoutSeconds: 0.01,
        maxTimeSeconds: 0.01,
        source: "standard",
      },
      validationSessionOptions: {
        env: {},
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        allowPrivateAddressesForTesting: true,
      },
    };

    try {
      const failure = await helpers
        .validateOpenAiLikeSelection(
          "Compatible endpoint",
          `http://provider.example.com:${port}/v1`,
          "qwen3-vl:4b",
          null,
          undefined,
          undefined,
          probeOptions,
        )
        .catch((caught) => caught);

      expect({
        failure,
        legacySpawnCalls: legacySpawn.mock.calls.length,
        output: error.mock.calls.map((args) => args.join(" ")),
        processExitCode: process.exitCode,
        promptCalls: promptValidationRecovery.mock.calls.length,
        teardownCalls: teardownOrphanManagedGatewayOnAbort.mock.calls.length,
      }).toEqual({
        failure: expect.objectContaining(resumableValidationExit),
        legacySpawnCalls: 0,
        output: [
          "  Compatible endpoint endpoint validation failed.",
          "  Validation probe summary: Chat Completions API with tool calling: curl exit 28.",
          "  Validation details were omitted to avoid exposing credentials.",
          "  Validation timed out before the provider replied. Retry, or check network/proxy health.",
          `  ${EXPECTED_WSL_SLOW_VERIFICATION_ADVISORY}`,
        ],
        processExitCode: 1,
        promptCalls: 0,
        teardownCalls: 1,
      });
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
    }
  });
});
