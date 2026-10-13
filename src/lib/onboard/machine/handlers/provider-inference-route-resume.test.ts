// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("published route repair on resume (#13018)", () => {
  it.each([
    {
      label: "defers NVIDIA before resumed sandbox creation",
      provider: "nvidia-prod",
      sandboxStep: "pending",
      defer: true,
    },
    {
      label: "applies NVIDIA after sandbox creation",
      provider: "nvidia-prod",
      sandboxStep: "complete",
      defer: undefined,
    },
    {
      label: "defers compatible endpoint before resumed sandbox creation",
      provider: "compatible-endpoint",
      sandboxStep: "pending",
      defer: true,
    },
    {
      label: "applies compatible endpoint after sandbox creation",
      provider: "compatible-endpoint",
      sandboxStep: "complete",
      defer: undefined,
    },
  ] as const)("$label", async ({ provider, sandboxStep, defer }) => {
    const session = createSession({
      provider,
      model: "nvidia/nemotron-test",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-responses",
    });
    session.steps.provider_selection.status = "complete";
    session.steps.sandbox.status = sandboxStep;
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      ensureResumeProviderReady: vi.fn(async () => ({
        forceInferenceSetup: true,
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      })),
    });
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.setupInference.mock.calls[0]?.[7]?.deferPublishedRouteReservation).toBe(defer);
  });
});
