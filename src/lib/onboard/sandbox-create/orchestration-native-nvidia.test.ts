// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { createProviderEffectBoundary } from "./orchestration";

const recordedProviderId = "11111111-2222-4333-8444-555555555555";

function providerAdapter(providerId: string): OpenShellProviderAdapter {
  return {
    importProviderProfile: vi.fn(() => ({ ok: true })),
    getProvider: vi.fn(async () => ({
      ok: true,
      value: {
        name: "nemoclaw-nvidia-prod-v1",
        type: "nemoclaw-nvidia-inference-v1",
        credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
        configKeys: [],
        revision: { id: providerId, resourceVersion: 1 },
      },
    })),
    listProviderAttachments: vi.fn(async () => ({
      ok: true,
      value: { names: ["nemoclaw-nvidia-prod-v1"] },
    })),
  } as unknown as OpenShellProviderAdapter;
}

function nativeProviderBoundary(
  adapter: OpenShellProviderAdapter,
  inferenceProvider = "nemoclaw-nvidia-prod-v1",
  missingReceipt = false,
) {
  return createProviderEffectBoundary({
    deferred: false,
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    expectedNativeHostedProviderAttachment: missingReceipt
      ? undefined
      : {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: recordedProviderId,
        },
    preparationInput: {
      openshellDriver: "docker",
      inferenceProvider,
      messagingProviders: [],
      messagingProviderRequests: [],
      extraProviders: [],
      gatewayName: "nemoclaw",
    },
    preparationDeps: {
      runOpenshell: vi.fn() as never,
      providerAdapter: adapter,
      cleanupCreateSources: vi.fn(),
    },
    runVerifiedSandboxCreateEffects: null,
    activateDeferredProviderEffects: async () => [],
    revalidateSandboxIdentityBeforeCreate: vi.fn(),
  });
}

function verifiedCreateContext(revalidateSandboxIdentity = vi.fn()) {
  return {
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    gatewayPort: 18790,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    route: "direct" as never,
    revalidateSandboxIdentity,
  };
}

describe("native NVIDIA post-create provider verification", () => {
  it("rejects a missing native receipt before creation", async () => {
    const boundary = nativeProviderBoundary(
      providerAdapter(recordedProviderId),
      "nemoclaw-nvidia-prod-v1",
      true,
    );
    await expect(boundary.validateBeforeCreate()).rejects.toThrow(
      "native hosted provider identity receipt",
    );
  });

  it("confirms the recorded provider is attached after sandbox identity is verified", async () => {
    const adapter = providerAdapter(recordedProviderId);
    const revalidateSandboxIdentity = vi.fn();
    const boundary = nativeProviderBoundary(adapter);

    await expect(
      boundary.runAfterVerifiedCreate?.(verifiedCreateContext(revalidateSandboxIdentity)),
    ).resolves.toBeUndefined();

    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "attaching and verifying native hosted provider for sandbox 'alpha'",
    );
    expect(adapter.listProviderAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "alpha" }),
    );
  });

  it("attaches the recorded provider after verified sandbox creation", async () => {
    const adapter = providerAdapter(recordedProviderId);
    vi.mocked(adapter.listProviderAttachments)
      .mockResolvedValueOnce({ ok: true, value: { names: [] } })
      .mockResolvedValueOnce({
        ok: true,
        value: { names: ["nemoclaw-nvidia-prod-v1"] },
      });
    adapter.attachProvider = vi.fn<OpenShellProviderAdapter["attachProvider"]>(async () => ({
      ok: true,
      value: { changed: true },
    }));
    const boundary = nativeProviderBoundary(adapter);

    await expect(
      boundary.runAfterVerifiedCreate?.(verifiedCreateContext()),
    ).resolves.toBeUndefined();

    expect(adapter.attachProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName: "alpha",
      providerName: "nemoclaw-nvidia-prod-v1",
    });
    expect(adapter.listProviderAttachments).toHaveBeenCalledTimes(2);
  });

  it("rejects an ownership receipt for a different selected native provider before gateway access", async () => {
    const adapter = providerAdapter(recordedProviderId);
    const boundary = nativeProviderBoundary(adapter, "nemoclaw-openai-api-v1");

    await expect(boundary.runAfterVerifiedCreate?.(verifiedCreateContext())).rejects.toThrow(
      /does not match the selected profile/u,
    );
    expect(adapter.getProvider).not.toHaveBeenCalled();
    expect(adapter.listProviderAttachments).not.toHaveBeenCalled();
  });

  it("publishes and verifies the physical provider for a logical OpenAI selection", async () => {
    const adapter = providerAdapter(recordedProviderId);
    vi.mocked(adapter.getProvider).mockResolvedValue({
      ok: true,
      value: {
        name: "nemoclaw-openai-api-v1",
        type: "nemoclaw-openai-inference-v1",
        credentialKeys: ["OPENAI_API_KEY"],
        configKeys: [],
        revision: { id: recordedProviderId, resourceVersion: 1 },
      },
    });
    adapter.updateProvider = vi.fn(async () => ({ ok: true as const }));
    vi.mocked(adapter.listProviderAttachments).mockResolvedValue({
      ok: true,
      value: { names: ["nemoclaw-openai-api-v1"] },
    });
    const revalidateSandboxIdentity = vi.fn();
    const preparationInput = {
      openshellDriver: "docker" as const,
      inferenceProvider: "openai-api",
      messagingProviders: [],
      messagingProviderRequests: [],
      extraProviders: [],
      gatewayName: "nemoclaw",
    };
    const boundary = createProviderEffectBoundary({
      deferred: false,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      expectedNativeHostedProviderAttachment: {
        schemaVersion: 1,
        profileId: "nemoclaw-openai-inference-v1",
        providerName: "nemoclaw-openai-api-v1",
        providerId: recordedProviderId,
      },
      preparationInput,
      preparationDeps: {
        runOpenshell: vi.fn() as never,
        providerAdapter: adapter,
        cleanupCreateSources: vi.fn(),
      },
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: null,
      revalidateSandboxIdentityBeforeCreate: revalidateSandboxIdentity,
    });

    await boundary.publishBeforeCreate();
    expect(revalidateSandboxIdentity).toHaveBeenCalledOnce();
    expect(adapter.updateProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      providerName: "nemoclaw-openai-api-v1",
      credentials: [],
      config: [],
    });
    expect(boundary.runAfterVerifiedCreate).toBeTypeOf("function");
    await boundary.runAfterVerifiedCreate!(verifiedCreateContext(revalidateSandboxIdentity));
    expect(adapter.listProviderAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "alpha" }),
    );
    expect(preparationInput.inferenceProvider).toBe("openai-api");
  });

  it("rejects a replaced provider before changing its sandbox attachments", async () => {
    const adapter = providerAdapter("99999999-2222-4333-8444-555555555555");
    adapter.attachProvider = vi.fn();
    adapter.detachProvider = vi.fn();
    const boundary = nativeProviderBoundary(adapter);

    await expect(boundary.runAfterVerifiedCreate?.(verifiedCreateContext())).rejects.toThrow(
      /changed identity.*Recreate the sandbox/u,
    );
    expect(adapter.attachProvider).not.toHaveBeenCalled();
    expect(adapter.detachProvider).not.toHaveBeenCalled();
  });
});
