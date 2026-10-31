// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../src/lib/adapters/openshell/provider-adapter";
import { inspectInferenceProviderProfile } from "../../src/lib/adapters/openshell/provider-profile";
import type { RegisteredInferenceProviderAttachment } from "../../src/lib/inference/native-provider/registered";

export function registeredInferenceFixture(attached = false) {
  const state = { attached, id: "operator-provider-id", revision: 4 };
  const profile = {
    id: "operator-inference",
    inference_capable: true,
    credentials: [
      {
        name: "api_key",
        env_vars: ["VENDOR_API_KEY"],
        auth_style: "bearer",
        header_name: "authorization",
        required: true,
      },
    ],
    endpoints: [
      {
        host: "native.example",
        port: 443,
        protocol: "rest",
        access: "read-write",
        enforcement: "enforce",
      },
    ],
    binaries: ["/usr/bin/curl", "/usr/local/bin/node"],
  };
  const projection = () => inspectInferenceProviderProfile(JSON.stringify(profile))!;
  const adapter = {
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true as const, value: undefined })),
    listProviders: vi.fn(async () => ({ ok: true as const, value: { names: ["native-extra"] } })),
    getProvider: vi.fn(async () => ({
      ok: true as const,
      value: {
        name: "native-extra",
        type: profile.id,
        credentialKeys: ["VENDOR_API_KEY"],
        configKeys: [],
        revision: { id: state.id, resourceVersion: state.revision },
      },
    })),
    inspectProviderProfile: vi.fn(async () => ({
      ok: true as const,
      value: { credentialKeys: ["VENDOR_API_KEY"], inference: projection() },
    })),
    listProviderAttachments: vi.fn(async () => ({
      ok: true as const,
      value: { names: state.attached ? ["native-extra"] : [] },
    })),
    attachProvider: vi.fn(async () => {
      state.attached = true;
      return { ok: true as const };
    }),
    detachProvider: vi.fn(async () => {
      state.attached = false;
      return { ok: true as const, value: { changed: true } };
    }),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    importProviderProfile: vi.fn(),
    configureProviderRefresh: vi.fn(),
    getProviderRefreshStatus: vi.fn(),
  } satisfies OpenShellProviderAdapter;
  const binding: RegisteredInferenceProviderAttachment = {
    schemaVersion: 1,
    gatewayName: "nemoclaw-18080",
    sandboxName: "alpha",
    providerName: "native-extra",
    providerId: state.id,
    profileId: profile.id,
    profileDigest: projection().digest,
    endpointUrl: "https://native.example/v1",
    inferenceApi: "openai-completions",
    credentialEnv: "VENDOR_API_KEY",
    attachedBySelection: false,
  };
  const handle = "openshell:resolve:env:s" + "a".repeat(64) + "_VENDOR_API_KEY";
  return { state, profile, adapter, binding, handle };
}
