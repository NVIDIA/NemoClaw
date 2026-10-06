// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { NativeCompatibleProviderAttachment } from "./contract";
import { vi } from "vitest";
import { prepareNativeCompatibleProfile } from "./profile";
import type { NativeCompatibleApi } from "./endpoint";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";

export async function nativeCompatibleFixture(
  endpointUrl = "https://93.184.216.34/v1",
  api: NativeCompatibleApi = "openai-completions",
  initiallyPresent = true,
) {
  const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  const profile = await prepareNativeCompatibleProfile({ endpointUrl, api, lookup });
  let present = initiallyPresent;
  const attached = new Set(initiallyPresent ? [profile.providerName] : []);
  const metadata = {
    name: profile.providerName,
    type: profile.profileId,
    credentialKeys: [profile.credentialEnv],
    configKeys: [],
    revision: { id: "owned-compatible", resourceVersion: 1 },
  };
  const adapter = {
    importProviderProfile: vi.fn(async () => ({ ok: true as const })),
    getProvider: vi.fn(async () =>
      present
        ? { ok: true as const, value: metadata }
        : {
            ok: false as const,
            error: {
              kind: "command" as const,
              reason: "not_found" as const,
              exitCode: 1,
              message: "not found",
            },
          },
    ),
    createProvider: vi.fn(async () => {
      present = true;
      return { ok: true as const };
    }),
    updateProvider: vi.fn(async () => ({ ok: true as const })),
    listProviderAttachments: vi.fn(async () => ({
      ok: true as const,
      value: { names: [...attached] },
    })),
    attachProvider: vi.fn(async () => {
      attached.add(profile.providerName);
      return { ok: true as const };
    }),
    detachProvider: vi.fn(async () => {
      attached.delete(profile.providerName);
      return { ok: true as const };
    }),
    deleteProvider: vi.fn(async () => {
      present = false;
      return { ok: true as const };
    }),
  };
  const receipt = {
    schemaVersion: 1 as const,
    profileId: profile.profileId,
    providerName: profile.providerName,
    providerId: metadata.revision.id,
    endpointUrl: profile.endpoint,
    addresses: profile.addresses,
    api,
  };
  return {
    profile,
    receipt,
    adapter,
    lookup,
    metadata,
    attached,
    providerAdapter: adapter as unknown as OpenShellProviderAdapter,
  };
}

export async function nativeCompatibleRotationFixture() {
  const previous = await nativeCompatibleFixture("https://compatible.example/v1");
  const lookup = vi.fn(async () => [{ address: "93.184.216.35", family: 4 }]);
  const next = await prepareNativeCompatibleProfile({
    endpointUrl: previous.profile.endpoint,
    api: previous.profile.api,
    lookup,
  });
  const nextReceipt = {
    ...previous.receipt,
    profileId: next.profileId,
    providerName: next.providerName,
    providerId: "new-owned-compatible",
    addresses: next.addresses,
  };
  const attachments = new Map<string, Set<string>>([
    ["alpha", new Set([previous.profile.providerName])],
    ["beta", new Set([previous.profile.providerName])],
  ]);
  const authorities = new Map<string, NativeCompatibleProviderAttachment>([
    [previous.receipt.profileId, previous.receipt],
  ]);
  let created = false;
  const adapter = {
    ...previous.providerAdapter,
    getProvider: vi.fn(async ({ providerName }: { providerName: string }) => {
      if (providerName === previous.profile.providerName)
        return { ok: true as const, value: previous.metadata };
      if (providerName === next.providerName && created)
        return {
          ok: true as const,
          value: {
            ...previous.metadata,
            name: next.providerName,
            type: next.profileId,
            revision: { id: nextReceipt.providerId, resourceVersion: 1 },
          },
        };
      return {
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "not_found" as const,
          exitCode: 1,
          message: "not found",
        },
      };
    }),
    createProvider: vi.fn(async () => {
      created = true;
      return { ok: true as const };
    }),
    listProviderAttachments: vi.fn(async ({ sandboxName }: { sandboxName: string }) => ({
      ok: true as const,
      value: { names: [...(attachments.get(sandboxName) ?? [])] },
    })),
    attachProvider: vi.fn(
      async ({ sandboxName, providerName }: { sandboxName: string; providerName: string }) => {
        attachments.get(sandboxName)?.add(providerName);
        return { ok: true as const };
      },
    ),
    detachProvider: vi.fn(
      async ({ sandboxName, providerName }: { sandboxName: string; providerName: string }) => {
        const changed = attachments.get(sandboxName)?.delete(providerName) ?? false;
        return { ok: true as const, value: { changed } };
      },
    ),
  };
  return { previous, lookup, next, nextReceipt, attachments, authorities, adapter };
}
