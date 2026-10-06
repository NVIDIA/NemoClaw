// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../../inference/bedrock-runtime";
import { nativeBedrockIdentity } from "../../inference/native-bedrock/contract";
import { runCredentialsResetAction } from "./reset";

vi.mock("../../credentials/command-support", () => ({
  isBridgeProviderName: () => false,
  recoverCredentialGatewayTargetOrExit: async () => ({
    kind: "named",
    gatewayName: "test-gateway",
  }),
}));

function fixture(pendingPeer = false) {
  const binding = {
    endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    adapterGeneration: "a".repeat(32),
    adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    gatewayName: "test-gateway",
  };
  const receipt = {
    schemaVersion: 1 as const,
    providerId: "owned",
    ...binding,
    ...nativeBedrockIdentity(binding),
  };
  const metadata = {
    name: receipt.providerName,
    type: receipt.profileId,
    revision: { id: "owned", resourceVersion: 1 },
    credentialKeys: ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
    configKeys: [],
  };
  const getProvider = vi
    .fn<OpenShellProviderAdapter["getProvider"]>()
    .mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "absent" },
    })
    .mockResolvedValueOnce({ ok: true, value: metadata });
  const deleteProvider = vi
    .fn<OpenShellProviderAdapter["deleteProvider"]>()
    .mockResolvedValue({ ok: true });
  const detachProvider = vi.fn();
  const clearAuthority = vi.fn();
  const run = (owns = true) =>
    runCredentialsResetAction(
      { provider: receipt.providerName, confirmed: true },
      {
        listSandboxes: () => ({
          sandboxes: pendingPeer
            ? [
                {
                  name: "pending-peer",
                  gatewayName: receipt.gatewayName,
                  nativeBedrockProviderAttachment: receipt,
                  pendingRouteReservation: true,
                },
              ]
            : [],
        }),
        providerAdapter: {
          getProvider,
          deleteProvider,
          detachProvider,
        } as unknown as OpenShellProviderAdapter,
        getNativeBedrockProviderAuthority: () => (owns ? receipt : undefined),
        clearNativeBedrockProviderAuthority: clearAuthority,
      },
    );
  return { receipt, metadata, getProvider, deleteProvider, detachProvider, clearAuthority, run };
}

describe("Bedrock credential reset ownership", () => {
  it("refuses reset before mutation when a pending sandbox reserves the provider", async () => {
    const f = fixture(true);
    const result = await f.run();
    expect(result.exitCode).toBe(1);
    expect(result.failureLines.join(" ")).toContain("pending onboarding");
    expect(f.getProvider).not.toHaveBeenCalled();
    expect(f.deleteProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("clears authority only after observing provider absence", async () => {
    const f = fixture();
    expect((await f.run()).exitCode).toBe(0);
    expect(f.getProvider).toHaveBeenCalledTimes(2);
    expect(f.clearAuthority).toHaveBeenCalledWith("test-gateway", f.receipt);
  });
  it("rejects missing authority before any remote mutation", async () => {
    const f = fixture();
    expect((await f.run(false)).exitCode).toBe(1);
    expect(f.deleteProvider).not.toHaveBeenCalled();
    expect(f.getProvider).not.toHaveBeenCalled();
  });
  it("never force detaches peer sandboxes", async () => {
    const f = fixture();
    f.deleteProvider.mockResolvedValue({
      ok: false,
      error: {
        kind: "command",
        reason: "attached",
        message: "attached",
        attachedSandboxes: ["peer"],
      },
    });
    expect((await f.run()).exitCode).toBe(1);
    expect(f.detachProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("retains authority after an unconfirmed deletion", async () => {
    const f = fixture();
    f.getProvider.mockResolvedValue({ ok: true, value: f.metadata });
    expect((await f.run()).exitCode).toBe(1);
    expect(f.deleteProvider).toHaveBeenCalledOnce();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("refuses a replaced provider identity", async () => {
    const f = fixture();
    f.metadata.revision.id = "replacement";
    expect((await f.run()).exitCode).toBe(1);
    expect(f.deleteProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
});
