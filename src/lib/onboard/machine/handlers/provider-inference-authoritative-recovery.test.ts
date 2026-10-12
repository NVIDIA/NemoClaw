// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import {
  activatedRecoveryReceipt,
  baseOptions,
  baseSelection,
  createDeps,
} from "./provider-inference.test-support";

describe("authoritative provider inference recovery", () => {
  it("carries legacy no-auth route authority through final inference setup", async () => {
    const endpointUrl = "http://localhost:11435/v1";
    const credentialEnv = "NEMOCLAW_OLLAMA_PROXY_TOKEN";
    const session = createSession({
      sandboxName: "my-assistant",
      provider: "compatible-endpoint",
      model: "mock/legacy-no-auth",
      endpointUrl,
      credentialEnv,
      preferredInferenceApi: "openai-completions",
    });
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      model: "mock/legacy-no-auth",
      provider: "compatible-endpoint",
      endpointUrl,
      credentialEnv,
      preferredInferenceApi: "openai-completions",
      recoveredFromSandbox: true,
    }));
    const { deps, calls } = createDeps({
      setupNim,
      isInferenceRouteReady: vi.fn(() => true),
    });
    const { receipt, ledger } = activatedRecoveryReceipt({
      sandboxName: "my-assistant",
      sessionId: session.sessionId,
      model: "mock/legacy-no-auth",
      endpointUrl,
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      authoritativeResumeConfig: true,
      providerRecoveryReceipt: receipt,
      providerRecoveryReceiptLedger: ledger,
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
    });

    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "mock/legacy-no-auth",
      "compatible-endpoint",
      endpointUrl,
      credentialEnv,
      null,
      [],
      expect.objectContaining({ allowLegacyRecordedNoAuthEndpoint: true }),
    );
  });

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

    const { receipt, ledger } = activatedRecoveryReceipt({
      sandboxName: "my-assistant",
      sessionId: session.sessionId,
    });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      authoritativeResumeConfig: true,
      providerRecoveryReceipt: receipt,
      providerRecoveryReceiptLedger: ledger,
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
      expect.any(Function),
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

  it("keeps the recorded reasoning mode and effort through gateway-credential reuse (#7940)", async () => {
    const session = createSession({
      sandboxName: "my-assistant",
      provider: "compatible-endpoint",
      model: "mock/channels-rebuild",
      endpointUrl: "https://compatible.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
    });
    // The recovered selection reused the gateway credential, so it never ran
    // the custom-endpoint validation that configures reasoning.
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      model: "mock/channels-rebuild",
      provider: "compatible-endpoint",
      endpointUrl: "https://compatible.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      recoveredFromSandbox: true,
      skipHostInferenceSmoke: true,
      reuseGatewayCredentialWithoutLocalKey: true,
    }));
    const { deps, calls } = createDeps({
      setupNim,
      hydrateCredentialEnv: vi.fn(() => null),
      isInferenceRouteReady: vi.fn(() => true),
    });
    const { receipt, ledger } = activatedRecoveryReceipt({
      sandboxName: "my-assistant",
      sessionId: session.sessionId,
    });
    const env: NodeJS.ProcessEnv = {};

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      authoritativeResumeConfig: true,
      providerRecoveryReceipt: receipt,
      providerRecoveryReceiptLedger: ledger,
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
      env,
    });

    expect(result.compatibleEndpointReasoning).toBe("true");
    expect(result.compatibleEndpointReasoningEffort).toBe("high");
    expect(env.NEMOCLAW_REASONING_EFFORT).toBe("high");
    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({ compatibleEndpointReasoningEffort: "high" }),
    );
  });

  it("names the recorded values it replays over a conflicting ambient request (#7462)", async () => {
    const session = createSession({
      sandboxName: "my-assistant",
      provider: "compatible-endpoint",
      model: "mock/channels-rebuild",
      endpointUrl: "https://compatible.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "high",
    });
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      model: "mock/channels-rebuild",
      provider: "compatible-endpoint",
      endpointUrl: "https://compatible.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      recoveredFromSandbox: true,
      skipHostInferenceSmoke: true,
      reuseGatewayCredentialWithoutLocalKey: true,
    }));
    const { deps, calls } = createDeps({
      setupNim,
      hydrateCredentialEnv: vi.fn(() => null),
      isInferenceRouteReady: vi.fn(() => true),
    });
    const { receipt, ledger } = activatedRecoveryReceipt({
      sandboxName: "my-assistant",
      sessionId: session.sessionId,
    });
    // The caller exported values that disagree with the recorded ones.
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_REASONING: "false",
      NEMOCLAW_REASONING_EFFORT: "low",
    };

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      authoritativeResumeConfig: true,
      providerRecoveryReceipt: receipt,
      providerRecoveryReceiptLedger: ledger,
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
      env,
    });

    const logged = calls.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("Ignoring NEMOCLAW_REASONING=false");
    expect(logged).toContain("recorded as reasoning=true");
    expect(logged).toContain("Ignoring NEMOCLAW_REASONING_EFFORT=low");
    expect(logged).toContain("reasoning effort=high");
    expect(result.compatibleEndpointReasoning).toBe("true");
    expect(result.compatibleEndpointReasoningEffort).toBe("high");
  });
});
