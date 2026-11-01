// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { createInferenceSelectionValidationHelpers } from "./inference-selection-validation";

afterEach(() => vi.unstubAllEnvs());

describe("custom endpoint validation with NEMOCLAW_PREFERRED_API", () => {
  it.each([
    ["completions", true],
    ["chat-completions", true],
    ["openai-responses", false],
  ])("skips the Responses probe for %s: %s (#13884)", async (preferredApi, skipsResponses) => {
    vi.stubEnv("NEMOCLAW_PREFERRED_API", preferredApi);
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true, api: "openai-completions" }));
    const helpers = createInferenceSelectionValidationHelpers({
      isNonInteractive: () => false,
      agentProductName: () => "OpenClaw",
      getCredential: () => "test-key",
      probeOpenAiLikeEndpoint,
      promptValidationRecovery: vi.fn(async () => "selection" as const),
      resolveEndpointHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    const result = await helpers.validateCustomOpenAiLikeSelection(
      "Custom endpoint",
      "https://vllm.public.test/v1",
      "model-a",
      "COMPATIBLE_API_KEY",
    );

    expect(result).toMatchObject({ ok: true });
    expect(probeOpenAiLikeEndpoint).toHaveBeenCalledTimes(1);
    const options = (probeOpenAiLikeEndpoint.mock.calls as unknown[][])[0]?.[3] as
      | { skipResponsesProbe?: boolean }
      | undefined;
    expect(options?.skipResponsesProbe === true).toBe(skipsResponses);
  });
});
