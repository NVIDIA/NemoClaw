// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";

import { describe, expect, it, vi } from "vitest";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import type { CliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import { createProviderEffectBoundary } from "./orchestration";

const recordedProviderId = "11111111-2222-4333-8444-555555555555";

function providerAdapter(
  providerId: string,
): OpenShellProviderAdapter &
  Pick<CliOpenShellProviderAdapter, "warnIfVerifiedProfilesChangedAfterSandboxCreate"> {
  return {
    importProviderProfile: vi.fn(() => ({ ok: true })),
    warnIfVerifiedProfilesChangedAfterSandboxCreate: vi.fn(),
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
  } as unknown as OpenShellProviderAdapter &
    Pick<CliOpenShellProviderAdapter, "warnIfVerifiedProfilesChangedAfterSandboxCreate">;
}

function nativeProviderBoundary(adapter: OpenShellProviderAdapter) {
  return createProviderEffectBoundary({
    deferred: false,
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    expectedNativeNvidiaProviderAttachment: {
      schemaVersion: 1,
      profileId: "nemoclaw-nvidia-inference-v1",
      providerName: "nemoclaw-nvidia-prod-v1",
      providerId: recordedProviderId,
    },
    preparationInput: {
      openshellDriver: "docker",
      inferenceProvider: "nemoclaw-nvidia-prod-v1",
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
  it("verifies the owned profile before direct create and checks it after verified attachment", async () => {
    const adapter = providerAdapter(recordedProviderId);
    const boundary = nativeProviderBoundary(adapter);

    await boundary.validateBeforeCreate();
    expect(adapter.importProviderProfile).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      profilePath: expect.stringContaining("nemoclaw-nvidia-inference-v1.yaml"),
    });
    expect(adapter.warnIfVerifiedProfilesChangedAfterSandboxCreate).not.toHaveBeenCalled();

    await boundary.runAfterVerifiedCreate?.(verifiedCreateContext());
    expect(adapter.warnIfVerifiedProfilesChangedAfterSandboxCreate).toHaveBeenCalledExactlyOnceWith(
      { target: { kind: "named", gatewayName: "nemoclaw" } },
      ["nemoclaw-nvidia-inference-v1"],
    );
  });

  it("stops a conflicting native profile before direct create", async () => {
    const adapter = providerAdapter(recordedProviderId);
    vi.mocked(adapter.importProviderProfile).mockReturnValue({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message: "catalog differs",
      },
    });
    const boundary = nativeProviderBoundary(adapter);

    await expect(boundary.validateBeforeCreate()).rejects.toThrow("conflicts");
    expect(adapter.warnIfVerifiedProfilesChangedAfterSandboxCreate).not.toHaveBeenCalled();
    expect(adapter.listProviderAttachments).not.toHaveBeenCalled();
  });

  it("confirms the recorded provider is attached after sandbox identity is verified", async () => {
    const adapter = providerAdapter(recordedProviderId);
    const revalidateSandboxIdentity = vi.fn();
    const boundary = nativeProviderBoundary(adapter);

    await expect(
      boundary.runAfterVerifiedCreate?.(verifiedCreateContext(revalidateSandboxIdentity)),
    ).resolves.toBeUndefined();

    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "attaching and verifying native NVIDIA provider for sandbox 'alpha'",
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
    expect(vi.mocked(adapter.attachProvider).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(adapter.warnIfVerifiedProfilesChangedAfterSandboxCreate).mock
        .invocationCallOrder[0],
    );
  });

  it("rejects a replaced provider before inspecting its sandbox attachments", async () => {
    const adapter = providerAdapter("99999999-2222-4333-8444-555555555555");
    const boundary = nativeProviderBoundary(adapter);

    await expect(boundary.runAfterVerifiedCreate?.(verifiedCreateContext())).rejects.toThrow(
      /changed identity.*Recreate the sandbox/u,
    );
    expect(adapter.listProviderAttachments).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "restores external provider membership without adopting its profile (attached=%s)",
  async (attached) => {
    const f = registeredInferenceFixture(attached);
    const boundary = createProviderEffectBoundary({
      deferred: false,
      sandboxName: f.binding.sandboxName,
      gatewayName: f.binding.gatewayName,
      expectedRegisteredInferenceProviderAttachment: f.binding,
      preparationInput: {
        openshellDriver: "docker",
        inferenceProvider: f.binding.providerName,
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [],
        gatewayName: f.binding.gatewayName,
      },
      preparationDeps: {
        providerAdapter: f.adapter,
        runOpenshell: vi.fn() as never,
        cleanupCreateSources: vi.fn(),
      },
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: null,
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });
    await boundary.validateBeforeCreate();
    await boundary.runAfterVerifiedCreate?.({
      ...verifiedCreateContext(),
      gatewayName: f.binding.gatewayName,
    });
    expect(f.adapter.attachProvider).toHaveBeenCalledTimes(attached ? 0 : 1);
    expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    f.state.id = "replacement";
    await expect(boundary.validateBeforeCreate()).rejects.toThrow();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
  },
);
