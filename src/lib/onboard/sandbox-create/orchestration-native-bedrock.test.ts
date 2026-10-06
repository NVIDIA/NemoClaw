// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { nativeBedrockIdentity } from "../../inference/native-bedrock/contract";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../../inference/bedrock-runtime";
vi.mock("../../inference/bedrock-runtime-adapter", async (original) => ({
  ...(await original<typeof import("../../inference/bedrock-runtime-adapter")>()),
  verifyBedrockRuntimeAdapterGeneration: vi.fn(async () => undefined),
}));
import { createProviderEffectBoundary } from "./orchestration";

const binding = {
  endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  region: "us-east-1",
  adapterGeneration: "a".repeat(32),
  adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  gatewayName: "nemoclaw",
};
const identity = nativeBedrockIdentity(binding);
const recordedProviderId = "11111111-2222-4333-8444-555555555555";

function providerAdapter(providerId: string): OpenShellProviderAdapter {
  return {
    inspectProviderProfile: vi.fn(async () => ({ ok: true })),
    attachProvider: vi.fn(),
    detachProvider: vi.fn(),
    getProvider: vi.fn(async () => ({
      ok: true,
      value: {
        name: identity.providerName,
        type: identity.profileId,
        credentialKeys: ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
        configKeys: [],
        revision: { id: providerId, resourceVersion: 1 },
      },
    })),
    listProviderAttachments: vi.fn(async () => ({
      ok: true,
      value: { names: [identity.providerName] },
    })),
  } as unknown as OpenShellProviderAdapter;
}

function nativeProviderBoundary(adapter: OpenShellProviderAdapter) {
  return createProviderEffectBoundary({
    deferred: false,
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    expectedNativeBedrockProviderAttachment: {
      ...binding,
      schemaVersion: 1,
      profileId: identity.profileId,
      providerName: identity.providerName,
      providerId: recordedProviderId,
    },
    preparationInput: {
      openshellDriver: "docker",
      inferenceProvider: identity.providerName,
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

describe("native Bedrock post-create provider verification", () => {
  it("confirms the recorded provider is attached after sandbox identity is verified", async () => {
    const adapter = providerAdapter(recordedProviderId);
    const revalidateSandboxIdentity = vi.fn();
    const boundary = nativeProviderBoundary(adapter);

    await expect(
      boundary.runAfterVerifiedCreate?.(verifiedCreateContext(revalidateSandboxIdentity)),
    ).resolves.toBeUndefined();

    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "attaching native Bedrock provider for sandbox 'alpha'",
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
        value: { names: [identity.providerName] },
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
      providerName: identity.providerName,
    });
    expect(adapter.listProviderAttachments).toHaveBeenCalledTimes(2);
  });

  it("rejects a replaced provider without changing its sandbox attachments", async () => {
    const adapter = providerAdapter("99999999-2222-4333-8444-555555555555");
    const boundary = nativeProviderBoundary(adapter);

    await expect(boundary.runAfterVerifiedCreate?.(verifiedCreateContext())).rejects.toThrow(
      /changed identity.*Recreate the sandbox/u,
    );
    expect(adapter.attachProvider).not.toHaveBeenCalled();
    expect(adapter.detachProvider).not.toHaveBeenCalled();
  });
});
