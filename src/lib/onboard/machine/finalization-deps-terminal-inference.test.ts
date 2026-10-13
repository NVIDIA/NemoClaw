// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { finalizationHandlerDeps, finalizationHandlerRuntime } from "./finalization-deps";
import { onboardInferenceVerificationContext } from "../../verify-deployment";
import {
  nativeLocalIdentity,
  NATIVE_LOCAL_CREDENTIAL_ENV,
} from "../../inference/native-local/contract";

const input = {
  sandboxName: "deep-code",
  agentName: "langchain-deepagents-code",
  provider: "openrouter-api",
  model: "moonshotai/kimi-k2.6",
  preferredInferenceApi: "openai-completions",
};
const localBinding = {
  provider: "ollama-local" as const,
  endpointUrl: "http://host.openshell.internal:11434/v1",
  credentialEnv: NATIVE_LOCAL_CREDENTIAL_ENV,
  authMode: "sentinel" as const,
  gatewayName: "nemoclaw-19090",
  sandboxName: "deep-code",
};
const localAttachment = {
  ...localBinding,
  ...nativeLocalIdentity(localBinding),
  schemaVersion: 1 as const,
  providerId: "provider-1",
};

describe("terminal inference finalization dependency", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the sandbox's recorded gateway for the bounded inference probe", async () => {
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => ({ sandboxes: { "deep-code": { gatewayName: "nemoclaw-19090" } } }),
    } as never);
    const probeOnboardInferenceInvocation = vi.fn(async () => ({ ok: true }));
    vi.spyOn(finalizationHandlerRuntime, "loadVerifyDeployment").mockReturnValue({
      onboardInferenceVerificationContext,
      probeOnboardInferenceInvocation,
    } as never);

    await expect(finalizationHandlerDeps.probeTerminalInference(input)).resolves.toEqual({
      ok: true,
    });
    expect(probeOnboardInferenceInvocation).toHaveBeenCalledExactlyOnceWith({
      ...input,
      gatewayName: "nemoclaw-19090",
      endpointUrl: null,
      nativeLocalExpected: false,
      nativeLocalProviderAttachment: undefined,
      nativeHostedProviderAttachment: undefined,
    });
  });

  it("passes the selected native local receipt to DCode's terminal agent probe", async () => {
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => ({
        sandboxes: {
          "deep-code": {
            gatewayName: "nemoclaw-19090",
            endpointUrl: localBinding.endpointUrl,
            nativeLocalProviderAttachment: localAttachment,
          },
        },
      }),
    } as never);
    const probeOnboardInferenceInvocation = vi.fn(async () => ({ ok: true }));
    vi.spyOn(finalizationHandlerRuntime, "loadVerifyDeployment").mockReturnValue({
      onboardInferenceVerificationContext,
      probeOnboardInferenceInvocation,
    } as never);

    await expect(
      finalizationHandlerDeps.probeTerminalInference({ ...input, provider: "ollama-local" }),
    ).resolves.toEqual({ ok: true });
    expect(probeOnboardInferenceInvocation).toHaveBeenCalledExactlyOnceWith({
      ...input,
      provider: "ollama-local",
      gatewayName: "nemoclaw-19090",
      endpointUrl: localBinding.endpointUrl,
      nativeLocalExpected: true,
      nativeLocalProviderAttachment: localAttachment,
      nativeHostedProviderAttachment: undefined,
    });
  });

  it("passes the sandbox native attachment to the terminal inference verifier", async () => {
    const nativeHostedProviderAttachment = { providerId: "owned-id" };
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => ({
        sandboxes: { "deep-code": { gatewayName: "nemoclaw", nativeHostedProviderAttachment } },
      }),
    } as never);
    const probeOnboardInferenceInvocation = vi.fn(async () => ({ ok: true }));
    vi.spyOn(finalizationHandlerRuntime, "loadVerifyDeployment").mockReturnValue({
      onboardInferenceVerificationContext,
      probeOnboardInferenceInvocation,
    } as never);
    await finalizationHandlerDeps.probeTerminalInference(input);
    expect(probeOnboardInferenceInvocation).toHaveBeenCalledExactlyOnceWith({
      ...input,
      gatewayName: "nemoclaw",
      endpointUrl: null,
      nativeLocalExpected: false,
      nativeLocalProviderAttachment: undefined,
      nativeHostedProviderAttachment,
    });
  });

  it("fails closed when the sandbox gateway identity is unavailable", async () => {
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => ({ sandboxes: {} }),
    } as never);
    const loadVerifyDeployment = vi.spyOn(finalizationHandlerRuntime, "loadVerifyDeployment");

    await expect(finalizationHandlerDeps.probeTerminalInference(input)).resolves.toEqual({
      ok: false,
      detail: "the sandbox gateway identity is unavailable",
    });
    expect(loadVerifyDeployment).not.toHaveBeenCalled();
  });

  it("fails closed when registry persistence cannot be read", async () => {
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => {
        throw new Error("registry unavailable");
      },
    } as never);

    await expect(finalizationHandlerDeps.probeTerminalInference(input)).resolves.toEqual({
      ok: false,
      detail: "the sandbox gateway identity is unavailable",
    });
  });
});
