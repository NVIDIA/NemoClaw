// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../../src/lib/adapters/openshell/provider-adapter";
import type { HermesSwitchyardRoutingIntent } from "../../src/lib/hermes-switchyard-routing";
import { prepareSwitchyardProviders } from "../../src/lib/onboard/switchyard/setup";

const missing = {
  ok: false,
  error: { kind: "command", reason: "not_found", message: "not found" },
} as const;

export function createSwitchyardProviderFixture(
  routing: HermesSwitchyardRoutingIntent,
  gatewayName = "test-gateway",
  sandboxName = "test-sandbox",
) {
  const target = { kind: "named", gatewayName } as const;
  const providers = new Map<string, OpenShellProviderMetadata>();
  const names: string[] = [];
  const methods = {
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async ({ providerName }) => {
      const value = providers.get(providerName);
      return value ? { ok: true, value: structuredClone(value) } : missing;
    }),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async (input) => {
      providers.set(input.name, {
        name: input.name,
        type: input.type,
        configKeys: [],
        credentialKeys: input.credentials.map((c) => c.name),
        revision: { id: `id-${providers.size}`, resourceVersion: 1 },
      });
      return { ok: true };
    }),
    deleteProvider: vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async ({ providerName }) => {
      providers.delete(providerName);
      return { ok: true };
    }),
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(() => ({
      ok: true,
    })),
    inspectProviderProfile: vi.fn<OpenShellProviderAdapter["inspectProviderProfile"]>(
      async ({ expectedProfile }) => ({
        ok: true,
        value: {
          credentialKeys:
            expectedProfile?.boundary.credentials.flatMap((c) => c.env_vars as string[]) ?? [],
        },
      }),
    ),
    ensureProviderPolicyComposition: vi.fn<
      OpenShellProviderAdapter["ensureProviderPolicyComposition"]
    >(async () => ({ ok: true, value: undefined })),
    listProviderAttachments: vi.fn<OpenShellProviderAdapter["listProviderAttachments"]>(
      async () => ({ ok: true, value: { names: [...names] } }),
    ),
    updateProvider: vi.fn<OpenShellProviderAdapter["updateProvider"]>(),
  };
  const adapter = methods as unknown as OpenShellProviderAdapter;
  const input = {
    routing,
    sandboxName,
    gatewayName,
    adapter,
    readCredential: (key: string) => `test-secret-${key}`,
  };
  const setup = async (intent = routing) => {
    const bindings = await prepareSwitchyardProviders({ ...input, routing: intent });
    names.push(...bindings.providers.map((p) => p.providerName));
    const observe = {
      routing: intent,
      adapter,
      target,
      providerNames: Object.fromEntries(
        bindings.providers.map((p) => [p.logicalProvider, p.providerName]),
      ),
    };
    return {
      bindings,
      observe,
      verify: { ...observe, expected: bindings, sandboxName: input.sandboxName },
    };
  };
  return { providers, names, methods, input, setup };
}
