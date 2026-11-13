// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { serializedOllamaHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import { onboardInferenceVerificationContext } from "../../verify-deployment";

import { finalizationHandlerDeps, finalizationHandlerRuntime } from "./finalization-deps";

const input = {
  sandboxName: "deep-code",
  agentName: "langchain-deepagents-code",
  provider: "openrouter-api",
  model: "moonshotai/kimi-k2.6",
  preferredInferenceApi: "openai-completions",
};

describe("terminal inference finalization dependency", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      label: "hosted Deep Agents Code",
      probeInput: input,
      entry: { gatewayName: "nemoclaw-19090" },
      endpointUrl: null,
    },
    {
      label: "Portable Hermes with a matching Ollama receipt",
      probeInput: {
        ...input,
        sandboxName: "portable-hermes",
        agentName: "hermes",
        provider: "ollama-local",
        model: "qwen3-vl:4b",
      },
      entry: {
        gatewayName: "nemoclaw-19090",
        agent: "hermes",
        portableLifecycleProfile: "hermes",
        provider: "ollama-local",
        model: "qwen3-vl:4b",
        endpointUrl: "https://inference.local/v1",
        hostLocalInferenceReceipt: serializedOllamaHostLocalInferenceReceipt("qwen3-vl:4b"),
      },
      endpointUrl: "https://inference.local/v1",
    },
  ])(
    "uses the recorded gateway and route for $label",
    async ({ probeInput, entry, endpointUrl }) => {
      vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
        load: () => ({ sandboxes: { [probeInput.sandboxName]: entry } }),
      } as never);
      const probeOnboardInferenceInvocation = vi.fn(async () => ({ ok: true }));
      vi.spyOn(finalizationHandlerRuntime, "loadVerifyDeployment").mockReturnValue({
        probeOnboardInferenceInvocation,
        onboardInferenceVerificationContext,
      } as never);

      await expect(finalizationHandlerDeps.probeTerminalInference(probeInput)).resolves.toEqual({
        ok: true,
      });
      expect(probeOnboardInferenceInvocation).toHaveBeenCalledExactlyOnceWith({
        ...probeInput,
        gatewayName: "nemoclaw-19090",
        endpointUrl,
        nativeLocalExpected: false,
      });
    },
  );

  it("passes the sandbox native attachment to the terminal inference verifier", async () => {
    const nativeHostedProviderAttachment = { providerId: "owned-id" };
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
      load: () => ({
        sandboxes: { "deep-code": { gatewayName: "nemoclaw", nativeHostedProviderAttachment } },
      }),
    } as never);
    const probeOnboardInferenceInvocation = vi.fn(async () => ({ ok: true }));
    vi.spyOn(finalizationHandlerRuntime, "loadVerifyDeployment").mockReturnValue({
      probeOnboardInferenceInvocation,
      onboardInferenceVerificationContext,
    } as never);
    await finalizationHandlerDeps.probeTerminalInference(input);
    expect(probeOnboardInferenceInvocation).toHaveBeenCalledExactlyOnceWith({
      ...input,
      gatewayName: "nemoclaw",
      endpointUrl: null,
      nativeLocalExpected: false,
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
