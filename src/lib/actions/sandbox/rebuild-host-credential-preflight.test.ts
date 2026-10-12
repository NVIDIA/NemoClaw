// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { validateRebuildHostInferenceCredential } from "./rebuild-provider-preflight";

const target = {
  provider: "compatible-endpoint",
  model: "test/model",
  endpointUrl: "https://inference.example.test/v1",
  credentialEnv: "COMPATIBLE_API_KEY",
  preferredInferenceApi: "openai-completions",
};

function dependencies() {
  return {
    assertEndpointResolvesPublic: vi
      .fn<typeof import("../../inference/endpoint-ssrf-preflight").assertEndpointResolvesPublic>()
      .mockResolvedValue({
        ok: true as const,
        addresses: ["93.184.216.34"],
      }),
    probeAnthropicEndpoint: vi.fn(async () => ({ ok: true, validated: true })),
    probeOpenAiLikeEndpointOptimized: vi.fn(async () => ({ ok: true, validated: true })),
  };
}

describe("rebuild host inference credential preflight", () => {
  it("validates the host key against the recorded endpoint with DNS pins (#12742)", async () => {
    const deps = dependencies();
    const key = "host-test-key";

    await expect(validateRebuildHostInferenceCredential(target, key, deps)).resolves.toBe(true);

    expect(deps.probeOpenAiLikeEndpointOptimized).toHaveBeenCalledWith(
      target.endpointUrl,
      target.model,
      key,
      expect.objectContaining({ skipResponsesProbe: true, pinnedAddresses: ["93.184.216.34"] }),
    );
    expect(deps.probeAnthropicEndpoint).not.toHaveBeenCalled();
  });

  it.each(["rejected", "unverified"])(
    "rejects a host key when endpoint validation is %s (#12742)",
    async (failure) => {
      const deps = dependencies();
      deps.probeOpenAiLikeEndpointOptimized.mockResolvedValue({
        ok: failure !== "rejected",
        validated: false,
      });

      await expect(
        validateRebuildHostInferenceCredential(target, "host-test-key", deps),
      ).resolves.toBe(false);
    },
  );

  it("rejects probe errors without exposing their credentials (#12742)", async () => {
    const deps = dependencies();
    const secret = "credential-shaped-upstream-error";
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    deps.probeOpenAiLikeEndpointOptimized.mockRejectedValue(new Error(secret));

    await expect(
      validateRebuildHostInferenceCredential(target, "host-test-key", deps),
    ).resolves.toBe(false);

    expect(output).not.toHaveBeenCalled();
  });

  it("rejects unsafe custom endpoints before sending the host key (#12742)", async () => {
    const deps = dependencies();
    deps.assertEndpointResolvesPublic.mockResolvedValue({ ok: false, reason: "private_address" });

    await expect(
      validateRebuildHostInferenceCredential(target, "host-test-key", deps),
    ).resolves.toBe(false);

    expect(deps.probeOpenAiLikeEndpointOptimized).not.toHaveBeenCalled();
  });

  it("rejects a malformed NVIDIA key before an upstream request (#12742)", async () => {
    const deps = dependencies();

    await expect(
      validateRebuildHostInferenceCredential(
        { ...target, provider: "nvidia-prod", credentialEnv: "NVIDIA_INFERENCE_API_KEY" },
        "invalid-test-key",
        deps,
      ),
    ).resolves.toBe(false);

    expect(deps.probeOpenAiLikeEndpointOptimized).not.toHaveBeenCalled();
  });

  it.each(["endpoint", "model"])(
    "rejects an incomplete recorded %s before probing (#12742)",
    async (missing) => {
      const deps = dependencies();
      await expect(
        validateRebuildHostInferenceCredential(
          { ...target, ...(missing === "endpoint" ? { endpointUrl: null } : { model: null }) },
          "host-test-key",
          deps,
        ),
      ).resolves.toBe(false);
      expect(deps.probeOpenAiLikeEndpointOptimized).not.toHaveBeenCalled();
    },
  );

  it("keeps Bedrock on its existing authentication preflight (#12742)", async () => {
    const deps = dependencies();
    await expect(
      validateRebuildHostInferenceCredential(
        {
          ...target,
          provider: "compatible-anthropic-endpoint",
          endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        },
        "host-test-key",
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.probeAnthropicEndpoint).not.toHaveBeenCalled();
    expect(deps.probeOpenAiLikeEndpointOptimized).not.toHaveBeenCalled();
  });

  it.each(["nvidia-prod", "nvidia-nim", "openai-api", "gemini-api", "openrouter-api"])(
    "validates the canonical endpoint for hosted provider %s (#12742)",
    async (provider) => {
      const deps = dependencies();
      await expect(
        validateRebuildHostInferenceCredential(
          { ...target, provider, endpointUrl: "http://169.254.169.254" },
          "nvapi-host-test-key",
          deps,
        ),
      ).resolves.toBe(true);

      expect(deps.assertEndpointResolvesPublic).not.toHaveBeenCalled();
      expect(deps.probeOpenAiLikeEndpointOptimized).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\//),
        target.model,
        "nvapi-host-test-key",
        expect.any(Object),
      );
    },
  );

  it.each(["anthropic-messages", "openai-completions"])(
    "validates the recorded Anthropic-compatible API %s (#12742)",
    async (preferredInferenceApi) => {
      const deps = dependencies();
      await expect(
        validateRebuildHostInferenceCredential(
          { ...target, provider: "compatible-anthropic-endpoint", preferredInferenceApi },
          "host-test-key",
          deps,
        ),
      ).resolves.toBe(true);

      expect(
        preferredInferenceApi === "anthropic-messages"
          ? deps.probeAnthropicEndpoint
          : deps.probeOpenAiLikeEndpointOptimized,
      ).toHaveBeenCalledOnce();
    },
  );

  it.each(["ollama-local", "vllm-local", "llama-cpp-local", "nvidia-router", "hermes-provider"])(
    "preserves the existing authentication preflight for %s (#12742)",
    async (provider) => {
      const deps = dependencies();
      await expect(
        validateRebuildHostInferenceCredential({ ...target, provider }, "host-test-key", deps),
      ).resolves.toBe(true);
      expect(deps.probeOpenAiLikeEndpointOptimized).not.toHaveBeenCalled();
      expect(deps.probeAnthropicEndpoint).not.toHaveBeenCalled();
    },
  );
});
