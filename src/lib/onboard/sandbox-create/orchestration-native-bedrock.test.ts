// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { nativeCompatibleEndpointIdentity } from "../../inference/native-compatible/endpoint";
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

function nativeProviderBoundary(
  adapter: OpenShellProviderAdapter,
  overrides: Partial<Parameters<typeof createProviderEffectBoundary>[0]> = {},
) {
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
    ...overrides,
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

  it.each([
    {
      state: "attached",
      names: [identity.providerName],
      error: /changed identity.*Recreate the sandbox/u,
    },
    {
      state: "unattached",
      names: [],
      error: /changed identity before attachment.*No provider was attached/u,
    },
  ])(
    "rejects a replaced $state provider without changing attachments",
    async ({ names, error }) => {
      const adapter = providerAdapter("99999999-2222-4333-8444-555555555555");
      vi.mocked(adapter.listProviderAttachments).mockResolvedValueOnce({
        ok: true,
        value: { names },
      });
      const boundary = nativeProviderBoundary(adapter);

      await expect(boundary.runAfterVerifiedCreate?.(verifiedCreateContext())).rejects.toThrow(
        error,
      );
      expect(adapter.attachProvider).not.toHaveBeenCalled();
      expect(adapter.detachProvider).not.toHaveBeenCalled();
    },
  );
});

const compatibleIdentity = nativeCompatibleEndpointIdentity({
  addresses: ["93.184.216.34"],
  endpointUrl: "https://93.184.216.34/v1",
  api: "openai-completions",
});
const compatibleReceipt = {
  schemaVersion: 1 as const,
  profileId: compatibleIdentity.profileId,
  providerName: compatibleIdentity.providerName,
  providerId: recordedProviderId,
  addresses: ["93.184.216.34"],
  endpointUrl: compatibleIdentity.endpoint,
  api: compatibleIdentity.api,
};
const bedrockReceipt = {
  ...binding,
  schemaVersion: 1 as const,
  ...identity,
  providerId: recordedProviderId,
};
const otherCompatibleIdentity = nativeCompatibleEndpointIdentity({
  addresses: ["93.184.216.34"],
  endpointUrl: "https://93.184.216.34/other",
  api: "openai-completions",
});
const invalidReceipts = [
  {
    name: "compatible missing",
    provider: compatibleIdentity.providerName,
    expectedMessage: "Sandbox is missing its matching native compatible provider receipt.",
  },
  {
    name: "compatible malformed",
    expectedMessage: "Sandbox is missing its matching native compatible provider receipt.",
    provider: compatibleIdentity.providerName,
    expectedNativeCompatibleProviderAttachment: {
      ...compatibleReceipt,
      providerId: "",
    },
  },
  {
    name: "compatible mismatched",
    expectedMessage: "Sandbox is missing its matching native compatible provider receipt.",
    provider: compatibleIdentity.providerName,
    expectedNativeCompatibleProviderAttachment: {
      ...compatibleReceipt,
      profileId: otherCompatibleIdentity.profileId,
      providerName: otherCompatibleIdentity.providerName,
      endpointUrl: otherCompatibleIdentity.endpoint,
    },
  },
  {
    name: "Bedrock missing",
    expectedMessage: "Sandbox is missing its matching native Bedrock provider receipt.",
    provider: identity.providerName,
    expectedNativeBedrockProviderAttachment: undefined,
  },
  {
    name: "Bedrock malformed",
    expectedMessage: "Sandbox is missing its matching native Bedrock provider receipt.",
    provider: identity.providerName,
    expectedNativeBedrockProviderAttachment: {
      ...bedrockReceipt,
      providerId: "",
    },
  },
  {
    name: "Bedrock mismatched",
    expectedMessage: "Sandbox is missing its matching native Bedrock provider receipt.",
    provider: nativeBedrockIdentity({ ...binding, gatewayName: "other" }).providerName,
    expectedNativeBedrockProviderAttachment: {
      ...bedrockReceipt,
      ...nativeBedrockIdentity({ ...binding, gatewayName: "other" }),
      gatewayName: "other",
    },
  },
];
describe.each([false, true])("native receipt pre-create validation deferred=%s", (deferred) => {
  it.each([
    {
      name: "compatible",
      provider: compatibleIdentity.providerName,
      expectedNativeCompatibleProviderAttachment: compatibleReceipt,
    },
    {
      name: "Bedrock",
      provider: identity.providerName,
      expectedNativeBedrockProviderAttachment: bedrockReceipt,
    },
  ])(
    "accepts a valid $name receipt before create",
    async ({ name: _name, provider, ...receipts }) => {
      const boundary = nativeProviderBoundary(providerAdapter(recordedProviderId), {
        ...receipts,
        deferred,
        preparationInput: {
          openshellDriver: "docker",
          inferenceProvider: provider,
          messagingProviders: [],
          messagingProviderRequests: [],
          extraProviders: [],
          gatewayName: "nemoclaw",
        },
      });
      await expect(boundary.validateBeforeCreate()).resolves.toBeUndefined();
    },
  );
  it.each(invalidReceipts)(
    "rejects $name before create effects",
    async ({ name: _name, provider, expectedMessage, ...receipts }) => {
      const adapter = providerAdapter(recordedProviderId);
      const createSandbox = vi.fn();
      const boundary = nativeProviderBoundary(adapter, {
        ...receipts,
        deferred,
        preparationInput: {
          openshellDriver: "docker",
          inferenceProvider: provider,
          messagingProviders: [],
          messagingProviderRequests: [],
          extraProviders: [],
          gatewayName: "nemoclaw",
        },
      });
      const attemptCreate = async () => {
        await boundary.validateBeforeCreate();
        await boundary.publishBeforeCreate();
        await createSandbox();
      };
      await expect(attemptCreate()).rejects.toThrow(expectedMessage);
      expect(createSandbox).not.toHaveBeenCalled();
    },
  );
});
