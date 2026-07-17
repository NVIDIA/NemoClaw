// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("Station Express provider binding (#7048)", () => {
  it("carries validated vLLM checkpoint identity into the atomic session update", async () => {
    const setupNim = vi.fn(async () => ({
      model: "nemotron-ultra",
      provider: "vllm-local",
      endpointUrl: null,
      credentialEnv: null,
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      nimContainer: null,
      vllmModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    }));
    const { deps, calls } = createDeps({ setupNim });
    const session = createSession({
      mode: "non-interactive",
      stationExpressIntent: {
        version: 1,
        model: "nemotron-3-ultra-550b-a55b",
        sandboxName: "my-assistant",
      },
    });
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "my-assistant",
    });

    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({
        provider: "vllm-local",
        model: "nemotron-ultra",
        stationExpressModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
      }),
    );
  });
});
