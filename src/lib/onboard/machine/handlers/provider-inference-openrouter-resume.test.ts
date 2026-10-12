// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("OpenRouter provider inference resume", () => {
  it("reconciles the adapter when resumed route metadata already matches", async () => {
    const session = createSession({
      agent: "langchain-deepagents-code",
      sandboxName: "deep-code",
      provider: "openrouter-api",
      model: "moonshotai/kimi-k2.6",
      credentialEnv: "OPENROUTER_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });
    calls.complete.mockResolvedValue(session);

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "deep-code",
      agent: { name: "langchain-deepagents-code" },
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.skipped).not.toHaveBeenCalledWith(
      "inference",
      "openrouter-api / moonshotai/kimi-k2.6",
    );
    expect(calls.setupInference).toHaveBeenCalledWith(
      "deep-code",
      "moonshotai/kimi-k2.6",
      "openrouter-api",
      null,
      "OPENROUTER_API_KEY",
      null,
      [],
      {
        gatewayName: "nemoclaw",
        allowToolsIncompatible: false,
        skipHostInferenceSmoke: true,
        reuseGatewayCredentialWithoutLocalKey: true,
        preferredInferenceApi: "openai-completions",
        endpointSource: null,
        reservationSessionId: session.sessionId,
      },
    );
    expect(calls.deleteEnv).toHaveBeenCalledWith("OPENROUTER_API_KEY");
  });
});
