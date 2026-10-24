// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import { createProviderEffectBoundary } from "./orchestration";

describe("registered provider recreation", () => {
  it.each([false, true])(
    "preserves operator ownership with deferred effects %s",
    async (deferred) => {
      const f = registeredInferenceFixture();
      f.adapter.updateProvider.mockResolvedValue({ ok: true });
      const revalidateSandboxIdentity = vi.fn();
      const boundary = createProviderEffectBoundary({
        deferred,
        sandboxName: f.binding.sandboxName,
        gatewayName: f.binding.gatewayName,
        expectedRegisteredInferenceProviderAttachment: f.binding,
        preparationInput: {
          openshellDriver: "docker",
          inferenceProvider: f.binding.providerName,
          messagingProviders: ["messaging-extra"],
          messagingProviderRequests: [],
          extraProviders: [f.binding.providerName, "owned-extra"],
          directCreateProviderNames: [],
          gatewayName: f.binding.gatewayName,
        },
        preparationDeps: {
          runOpenshell: vi.fn(),
          cleanupCreateSources: vi.fn(),
          providerAdapter: f.adapter,
        },
        runVerifiedSandboxCreateEffects: null,
        activateDeferredProviderEffects: async () => [],
        revalidateSandboxIdentityBeforeCreate: revalidateSandboxIdentity,
      });
      await boundary.validateBeforeCreate();
      expect(f.adapter.getProvider).toHaveBeenCalled();
      expect(f.adapter.inspectProviderProfile).toHaveBeenCalled();
      await boundary.publishBeforeCreate();
      await boundary.runAfterVerifiedCreate!({
        sandboxName: f.binding.sandboxName,
        gatewayName: f.binding.gatewayName,
        gatewayPort: 18080,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "direct" as never,
        revalidateSandboxIdentity,
      });
      expect(f.adapter.updateProvider.mock.calls.map(([request]) => request.providerName)).toEqual([
        "messaging-extra",
        "owned-extra",
      ]);
      expect(f.adapter.attachProvider).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "named", gatewayName: f.binding.gatewayName },
        sandboxName: f.binding.sandboxName,
        providerName: f.binding.providerName,
      });
      expect(f.state.attached).toBe(true);
      expect(f.adapter.createProvider).not.toHaveBeenCalled();
      expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
      expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
    },
  );
});
