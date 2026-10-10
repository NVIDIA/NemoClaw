// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  customAttachmentFromPrepared,
  prepareNativeCustomProfile,
} from "../../../inference/native-custom";
import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("native custom provider inference resume", () => {
  it.each([false, true])(
    "rebuilds from retained native authority with session receipt=%s without asking for a host key (#12636)",
    async (persistedReceipt) => {
      const prepared = await prepareNativeCustomProfile({
        sandboxName: "custom-agent",
        provider: "compatible-endpoint",
        api: "openai-completions",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      });
      const receipt = customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "retained-provider-id",
      });
      const session = createSession({
        agent: "openclaw",
        sandboxName: "custom-agent",
        provider: "compatible-endpoint",
        model: "nvidia/test",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
        ...(persistedReceipt ? { nativeCustomProviderAttachment: receipt } : {}),
      });
      session.steps.provider_selection.status = "complete";
      const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });
      const hasRetainedNativeCustomSelection = vi.fn(() => true);
      calls.recoverProvider.mockRejectedValue(new Error("COMPATIBLE_API_KEY is required"));
      calls.complete.mockResolvedValue(session);

      await handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "custom-agent",
        deps: { ...deps, hasRetainedNativeCustomSelection },
      });

      expect(calls.recoverProvider).not.toHaveBeenCalled();
      expect(hasRetainedNativeCustomSelection).toHaveBeenCalledWith({
        gatewayName: "nemoclaw",
        sandboxName: "custom-agent",
        provider: "compatible-endpoint",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
        credentialEnv: "COMPATIBLE_API_KEY",
        ...(persistedReceipt ? { nativeCustomProviderAttachment: receipt } : {}),
      });
      expect(calls.setupInference).toHaveBeenCalledWith(
        "custom-agent",
        "nvidia/test",
        "compatible-endpoint",
        "https://integrate.api.nvidia.com/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        expect.objectContaining({
          gatewayName: "nemoclaw",
          reuseGatewayCredentialWithoutLocalKey: true,
          skipHostInferenceSmoke: true,
          ...(persistedReceipt ? { nativeCustomProviderAttachment: receipt } : {}),
        }),
      );
    },
  );
});
