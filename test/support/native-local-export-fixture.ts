// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import { raw } from "./config-export-harness";
import {
  nativeNvidiaProfile,
  inventory,
  readFailureCanary,
} from "../../src/lib/adapters/config/live-export-source-test-fixture";
import {
  nativeLocalIdentity,
  NATIVE_LOCAL_CREDENTIAL_ENV,
  type NativeLocalBinding,
} from "../../src/lib/inference/native-local/contract";
import { prepareNativeLocalProfile } from "../../src/lib/inference/native-local/profile";
import type { SandboxEntry } from "../../src/lib/state/registry/types";

/** Replace the existing local source's live provider with its native attachment. */
export function attachNativeLocalExportFixture(source: SandboxEntry) {
  const binding: NativeLocalBinding = {
    provider: source.provider as "ollama-local" | "vllm-local",
    endpointUrl: source.endpointUrl!,
    credentialEnv: NATIVE_LOCAL_CREDENTIAL_ENV,
    authMode: "authenticated",
    gatewayName: source.gatewayName!,
    sandboxName: source.name,
  };
  const receipt = {
    ...binding,
    ...nativeLocalIdentity(binding),
    schemaVersion: 1 as const,
    providerId: "native-local-id",
  };
  source.nativeLocalProviderAttachment = receipt;
  const readCredential = vi.fn(() => {
    throw new Error(readFailureCanary);
  });
  const provider = {
    metadata: {
      id: receipt.providerId,
      name: receipt.providerName,
      workspace: "default",
      resourceVersion: 8n,
    },
    type: receipt.profileId,
    profileWorkspace: "default",
    credentials: Object.defineProperty({}, NATIVE_LOCAL_CREDENTIAL_ENV, {
      enumerable: true,
      get: readCredential,
    }),
    config: {},
  };
  const profile = nativeNvidiaProfile();
  profile.id = receipt.profileId;
  profile.credentials = [
    {
      name: "api_key",
      envVars: [NATIVE_LOCAL_CREDENTIAL_ENV],
      required: true,
      authStyle: "bearer",
      headerName: "authorization",
      queryParam: "",
      pathTemplate: "",
    },
  ];
  const endpoint = (profile.endpoints as Record<string, unknown>[])[0]!;
  const url = new URL(binding.endpointUrl);
  Object.assign(endpoint, {
    host: url.hostname,
    port: Number(url.port),
    allowedIps: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  });
  profile.binaries = prepareNativeLocalProfile(binding).document.binaries.map((path) => ({ path }));
  const sandbox = inventory();
  Object.assign(sandbox.sandbox.spec, { providers: [receipt.providerName] });
  raw.getSandbox.mockResolvedValue(sandbox);
  raw.getProvider.mockResolvedValue({ provider });
  raw.getProviderProfile.mockResolvedValue({ profile });
  return { receipt, provider, profile, endpoint, readCredential };
}
