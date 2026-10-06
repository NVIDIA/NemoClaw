// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../inference/bedrock-runtime";
import { nativeBedrockIdentity } from "../inference/native-bedrock/contract";
import { retireDestroyedSandboxBedrockProvider } from "./sandbox-provider-cleanup";

function fixture() {
  const binding = {
    endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    adapterGeneration: "a".repeat(32),
    adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    gatewayName: "selected-gateway",
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
    revision: { id: receipt.providerId, resourceVersion: 1 },
    configKeys: [],
    credentialKeys: ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
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
  const adapter = {
    getProvider,
    deleteProvider,
    detachProvider,
  } as unknown as OpenShellProviderAdapter;
  const getAuthority = vi.fn(() => receipt);
  const clearAuthority = vi.fn();
  const run = (gatewayName = binding.gatewayName) =>
    retireDestroyedSandboxBedrockProvider(
      { gatewayName, expected: receipt },
      { providerAdapter: adapter, getAuthority, clearAuthority },
    );
  return {
    receipt,
    metadata,
    getProvider,
    deleteProvider,
    detachProvider,
    getAuthority,
    clearAuthority,
    run,
  };
}

describe("destroyed sandbox Bedrock provider retirement", () => {
  it("observes exact provider absence before retiring authority", async () => {
    const f = fixture();
    await f.run();
    expect(f.deleteProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: f.receipt.gatewayName },
      providerName: f.receipt.providerName,
    });
    expect(f.getProvider).toHaveBeenCalledTimes(2);
    expect(f.clearAuthority).toHaveBeenCalledWith(f.receipt.gatewayName, f.receipt);
  });
  it("refuses a different gateway before any provider operation", async () => {
    const f = fixture();
    await expect(f.run("peer-gateway")).rejects.toThrow("ownership changed");
    expect(f.getProvider).not.toHaveBeenCalled();
    expect(f.deleteProvider).not.toHaveBeenCalled();
  });
  it("refuses changed provider identity without deleting", async () => {
    const f = fixture();
    f.metadata.revision.id = "replacement";
    await expect(f.run()).rejects.toThrow("identity changed");
    expect(f.deleteProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
  it("retains attached peers without detaching them", async () => {
    const f = fixture();
    f.deleteProvider.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "attached", message: "peer", attachedSandboxes: ["peer"] },
    });
    await f.run();
    expect(f.detachProvider).not.toHaveBeenCalled();
    expect(f.clearAuthority).not.toHaveBeenCalled();
    expect(f.getProvider).toHaveBeenCalledOnce();
  });
  it("retains recovery authority when removal is uncertain", async () => {
    const f = fixture();
    f.getProvider.mockResolvedValue({ ok: true, value: f.metadata });
    await expect(f.run()).rejects.toThrow("not confirmed");
    expect(f.deleteProvider).toHaveBeenCalledOnce();
    expect(f.clearAuthority).not.toHaveBeenCalled();
  });
});
