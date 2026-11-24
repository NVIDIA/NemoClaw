// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import { hostedNativeProvider } from "../../src/lib/inference/native-provider/hosted";
import type { OpenShellProviderAdapter } from "../../src/lib/adapters/openshell/provider-adapter";
import type { SetupInferenceDeps } from "../../src/lib/onboard/setup-inference";
import { createDirectSetupInferenceHarness } from "../helpers/onboard-split-context";

const HERMES_NATIVE_DEFINITION = {
  ...hostedNativeProvider("hermes-provider", "https://8.8.8.8/v1")!,
  allowedIps: ["8.8.8.8"],
};
export const HERMES_NATIVE_RECEIPT = {
  schemaVersion: 1 as const,
  profileId: HERMES_NATIVE_DEFINITION.profileId,
  providerName: HERMES_NATIVE_DEFINITION.providerName,
  providerId: "hermes-owned-provider",
  endpointUrl: HERMES_NATIVE_DEFINITION.endpoint,
  allowedIps: HERMES_NATIVE_DEFINITION.allowedIps,
};

export function createHermesNativeHarness(overrides: Partial<SetupInferenceDeps> = {}) {
  const providerAdapter = {
    importProviderProfile: vi.fn(async () => ({ ok: true })),
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
    getProvider: vi.fn(async () => ({
      ok: true,
      value: {
        name: HERMES_NATIVE_RECEIPT.providerName,
        type: HERMES_NATIVE_RECEIPT.profileId,
        credentialKeys: ["OPENAI_API_KEY"],
        configKeys: [],
        revision: { id: HERMES_NATIVE_RECEIPT.providerId, resourceVersion: 1 },
      },
    })),
    createProvider: vi.fn(async () => ({ ok: true })),
    updateProvider: vi.fn(async () => ({ ok: true })),
  } as unknown as OpenShellProviderAdapter;
  const writeAuthority = vi.fn();
  const harness = createDirectSetupInferenceHarness({
    overrides: {
      isNonInteractive: () => true,
      providerAdapter,
      getNativeHostedProviderAuthority: () => HERMES_NATIVE_RECEIPT,
      setNativeHostedProviderAuthority: writeAuthority,
      ...overrides,
    },
  });
  return { ...harness, providerAdapter, writeAuthority };
}
