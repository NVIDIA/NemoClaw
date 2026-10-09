// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("native custom provider inference resume", () => {
  it("rebuilds from retained native authority without asking for a host key (#12636)", async () => {
    const session = createSession({
      agent: "openclaw",
      sandboxName: "custom-agent",
      provider: "compatible-endpoint",
      model: "nvidia/test",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });
    const hasRetainedNativeCustomSelection = vi.fn(() => true);
    calls.recoverProvider.mockRejectedValue(new Error("COMPATIBLE_API_KEY is required"));
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "custom-agent",
      deps: { ...deps, hasRetainedNativeCustomSelection },
    });

    expect(calls.recoverProvider).not.toHaveBeenCalled();
    expect(hasRetainedNativeCustomSelection).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      sandboxName: "custom-agent",
      provider: "compatible-endpoint",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      api: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    expect(calls.setupInference).toHaveBeenCalledWith(
      "custom-agent",
      "nvidia/test",
      "compatible-endpoint",
      "https://integrate.api.nvidia.com/v1",
      "COMPATIBLE_API_KEY",
      null,
      [],
      expect.objectContaining({
        gatewayName: "nemoclaw",
        reuseGatewayCredentialWithoutLocalKey: true,
        skipHostInferenceSmoke: true,
      }),
    );
  });
});
