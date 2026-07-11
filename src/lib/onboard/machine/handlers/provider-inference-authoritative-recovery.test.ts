// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

describe("authoritative provider inference recovery", () => {
  it("stays enabled across messaging revalidation", async () => {
    const session = createSession({
      sandboxName: "my-assistant",
      provider: "compatible-endpoint",
      model: "mock/channels-rebuild",
      endpointUrl: "https://compatible.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    const recoveredSelection = {
      ...baseSelection,
      model: "mock/channels-rebuild",
      provider: "compatible-endpoint",
      endpointUrl: "https://compatible.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      recoveredFromSandbox: true,
      skipHostInferenceSmoke: true,
      reuseGatewayCredentialWithoutLocalKey: true,
    };
    const setupNim = vi.fn(async () => recoveredSelection);
    const { deps, calls } = createDeps({
      setupNim,
      hydrateCredentialEnv: vi.fn(() => null),
      isInferenceRouteReady: vi.fn(() => true),
    });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      authoritativeResumeConfig: true,
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
    });

    expect(setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "my-assistant",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
    );
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "mock/channels-rebuild",
      "compatible-endpoint",
      "https://compatible.example.test/v1",
      "COMPATIBLE_API_KEY",
      null,
      [],
      expect.objectContaining({
        skipHostInferenceSmoke: true,
        reuseGatewayCredentialWithoutLocalKey: true,
        reservationSessionId: session.sessionId,
      }),
    );
    expect(result).toMatchObject({
      provider: "compatible-endpoint",
      model: "mock/channels-rebuild",
      endpointUrl: "https://compatible.example.test/v1",
    });
  });
});
