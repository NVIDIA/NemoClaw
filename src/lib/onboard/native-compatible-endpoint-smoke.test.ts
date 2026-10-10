// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as nativeCustom from "../inference/native-custom";
import type { OpenShellSandboxBufferedCommandRequest } from "../adapters/openshell/sandbox-command";
import { verifyCompatibleEndpointSandboxSmoke } from "./compatible-endpoint-smoke";

describe("native custom onboarding inference verification", () => {
  it.each(["openclaw", "hermes"])(
    "verifies attached native inference for %s without the shared route",
    async (agentName) => {
      const prepared = await nativeCustom.prepareNativeCustomProfile({
        sandboxName: "smoke-sandbox",
        provider: "compatible-endpoint",
        endpointUrl: "https://api.example.com/v1",
        api: "openai-completions",
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      });
      const receipt = nativeCustom.customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "native-id",
      });
      const verify = vi
        .spyOn(nativeCustom, "verifyNativeCustomProviderAttachment")
        .mockResolvedValue(receipt);
      const executor = {
        runBuffered: vi.fn(async (_request: OpenShellSandboxBufferedCommandRequest) => ({
          outcome: { kind: "completed" as const, exitCode: 0 },
          stdout: '200\n{"choices":[{"message":{"content":"OK"}}]}',
          stderr: "",
        })),
      };
      try {
        await verifyCompatibleEndpointSandboxSmoke({
          sandboxName: "smoke-sandbox",
          provider: "compatible-endpoint",
          model: "example-model",
          gatewayName: "gateway",
          nativeCustomProviderAttachment: receipt,
          runOpenshell: vi.fn(),
          sandboxCommandExecutor: executor,
          redact: (value) => value,
          agent: { name: agentName },
        });
        expect(verify).toHaveBeenCalledWith(
          expect.objectContaining({
            sandboxName: "smoke-sandbox",
            expected: receipt,
            target: { kind: "named", gatewayName: "gateway" },
          }),
        );
        expect(executor.runBuffered).toHaveBeenCalledOnce();
        const command = executor.runBuffered.mock.calls[0]?.[0] as
          | OpenShellSandboxBufferedCommandRequest
          | undefined;
        expect(command?.command.join(" ")).toContain("https://api.example.com/v1/chat/completions");
        expect(command?.command.join(" ")).not.toContain("inference.local");
        verify.mockRejectedValueOnce(new Error("attachment replaced"));
        executor.runBuffered.mockClear();
        await expect(
          verifyCompatibleEndpointSandboxSmoke({
            sandboxName: "smoke-sandbox",
            provider: "compatible-endpoint",
            model: "example-model",
            gatewayName: "gateway",
            nativeCustomProviderAttachment: receipt,
            runOpenshell: vi.fn(),
            sandboxCommandExecutor: executor,
            redact: (value) => value,
            onFailure: () => {
              throw new Error("verification failed");
            },
          }),
        ).rejects.toThrow("verification failed");
        expect(executor.runBuffered).not.toHaveBeenCalled();
      } finally {
        verify.mockRestore();
      }
    },
  );
});
