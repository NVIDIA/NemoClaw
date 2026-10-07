// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../bedrock-runtime";
import { nativeBedrockIdentity } from "./contract";

export function nativeBedrockSwitchFixture(gatewayName = "nemoclaw") {
  const binding = {
    endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    adapterGeneration: "a".repeat(32),
    adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    gatewayName,
  };
  const receipt = {
    schemaVersion: 1 as const,
    providerId: "owned-bedrock",
    ...binding,
    ...nativeBedrockIdentity(binding),
  };
  let present = true;
  const attachments = new Set([receipt.providerName]);
  const metadata = {
    name: receipt.providerName,
    type: receipt.profileId,
    revision: { id: receipt.providerId, resourceVersion: 1 },
    configKeys: [],
    credentialKeys: ["NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN"],
  };
  const adapter = {
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(() => ({
      ok: true,
    })),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({ ok: true })),
    getProvider: vi.fn(async () =>
      present
        ? { ok: true as const, value: metadata }
        : {
            ok: false as const,
            error: { kind: "command" as const, reason: "not_found" as const, message: "absent" },
          },
    ),
    inspectProviderProfile: vi.fn(async () => ({
      ok: true as const,
      value: { credentialKeys: metadata.credentialKeys },
    })),
    listProviderAttachments: vi.fn(async () => ({
      ok: true as const,
      value: { names: [...attachments] },
    })),
    attachProvider: vi.fn(async () => {
      attachments.add(receipt.providerName);
      return { ok: true as const };
    }),
    detachProvider: vi.fn(async () => {
      attachments.delete(receipt.providerName);
      return { ok: true as const };
    }),
    deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => {
      present = false;
      return { ok: true as const };
    }),
  };
  return {
    receipt,
    adapter,
    attachments,
    providerAdapter: adapter as unknown as OpenShellProviderAdapter,
  };
}
