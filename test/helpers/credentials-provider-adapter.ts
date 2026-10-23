// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../src/lib/adapters/openshell/provider-adapter";

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
    ensureProviderPolicyComposition: vi
      .fn<OpenShellProviderAdapter["ensureProviderPolicyComposition"]>()
      .mockResolvedValue({ ok: true, value: undefined }),
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
