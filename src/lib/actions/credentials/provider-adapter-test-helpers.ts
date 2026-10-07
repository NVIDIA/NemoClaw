// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";

export function providerAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  const listProviders: OpenShellProviderAdapter["listProviders"] = async () => ({
    ok: true,
    value: { names: [] },
  });
  const createProvider: OpenShellProviderAdapter["createProvider"] = async () => ({
    ok: true,
  });
  const getProvider: OpenShellProviderAdapter["getProvider"] = async (request) => ({
    ok: true,
    value: { name: request.providerName, type: "generic", credentialKeys: [], configKeys: [] },
  });
  const updateProvider: OpenShellProviderAdapter["updateProvider"] = async () => ({
    ok: true,
  });
  const importProviderProfile: OpenShellProviderAdapter["importProviderProfile"] = async () => ({
    ok: true,
  });
  const inspectProviderProfile: OpenShellProviderAdapter["inspectProviderProfile"] = async () => ({
    ok: true,
    value: { credentialKeys: [] },
  });
  const deleteProvider: OpenShellProviderAdapter["deleteProvider"] = async () => ({
    ok: true,
  });
  const detachProvider: OpenShellProviderAdapter["detachProvider"] = async () => ({
    ok: true,
    value: { changed: true },
  });
  const attachProvider: OpenShellProviderAdapter["attachProvider"] = async () => ({ ok: true });
  const listProviderAttachments: OpenShellProviderAdapter["listProviderAttachments"] =
    async () => ({ ok: true, value: { names: [] } });
  const configureProviderRefresh: OpenShellProviderAdapter["configureProviderRefresh"] =
    async () => ({ ok: true });
  const getProviderRefreshStatus: OpenShellProviderAdapter["getProviderRefreshStatus"] =
    async () => ({ ok: true, value: { status: "refreshed" } });
  return {
    listProviders: vi.fn(listProviders),
    createProvider: vi.fn(createProvider),
    getProvider: vi.fn(getProvider),
    updateProvider: vi.fn(updateProvider),
    importProviderProfile: vi.fn(importProviderProfile),
    inspectProviderProfile: vi.fn(inspectProviderProfile),
    deleteProvider: vi.fn(deleteProvider),
    detachProvider: vi.fn(detachProvider),
    attachProvider: vi.fn(attachProvider),
    listProviderAttachments: vi.fn(listProviderAttachments),
    configureProviderRefresh: vi.fn(configureProviderRefresh),
    getProviderRefreshStatus: vi.fn(getProviderRefreshStatus),
    ...overrides,
  };
}

export function nativeNvidiaProviderAdapter(providerPresent = false): OpenShellProviderAdapter {
  return providerAdapter({
    getProvider: vi.fn(async (request) =>
      providerPresent
        ? {
            ok: true as const,
            value: {
              name: request.providerName,
              type: "nemoclaw-nvidia-inference-v1",
              credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
              configKeys: [],
              revision: {
                id: "11111111-2222-4333-8444-555555555555",
                resourceVersion: 1,
              },
            },
          }
        : {
            ok: false as const,
            error: {
              kind: "command" as const,
              reason: "not_found" as const,
              message: "provider not found",
            },
          },
    ),
    createProvider: vi.fn(async () => {
      providerPresent = true;
      return { ok: true as const };
    }),
    deleteProvider: vi.fn(async () => {
      providerPresent = false;
      return { ok: true as const };
    }),
  });
}

export const nativeNvidiaAuthority = {
  schemaVersion: 1,
  profileId: "nemoclaw-nvidia-inference-v1",
  providerName: "nemoclaw-nvidia-prod-v1",
  providerId: "11111111-2222-4333-8444-555555555555",
} as const;
