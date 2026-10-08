// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("Native hosted provider inference resume", () => {
  it.each([
    {
      provider: "openrouter-api",
      model: "moonshotai/kimi-k2.6",
      credential: "OPENROUTER_API_KEY",
      resumeOptions: { skipHostInferenceSmoke: true, reuseGatewayCredentialWithoutLocalKey: true },
    },
    { provider: "openai-api", model: "gpt-4.1", credential: "OPENAI_API_KEY", resumeOptions: {} },
  ])(
    "reconciles $provider when shared route metadata already matches",
    async ({ provider, model, credential, resumeOptions }) => {
      const session = createSession({
        agent: "langchain-deepagents-code",
        sandboxName: "deep-code",
        provider,
        model,
        credentialEnv: credential,
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
      expect(calls.skipped).not.toHaveBeenCalledWith("inference", `${provider} / ${model}`);
      expect(calls.setupInference).toHaveBeenCalledWith(
        "deep-code",
        model,
        provider,
        null,
        credential,
        null,
        [],
        {
          gatewayName: "nemoclaw",
          allowToolsIncompatible: false,
          ...resumeOptions,
          preferredInferenceApi: "openai-completions",
          endpointSource: null,
          reservationSessionId: session.sessionId,
        },
      );
      expect(calls.deleteEnv).toHaveBeenCalledWith(credential);
    },
  );
});
