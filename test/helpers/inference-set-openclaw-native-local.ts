// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  nativeLocalIdentity,
  type NativeLocalProviderAttachment,
} from "../../src/lib/inference/native-local/contract";
import type { ConfigObject } from "../../src/lib/security/credential-filter";
import { createDeps } from "./inference-set";

const binding = {
  agent: "openclaw" as const,
  provider: "ollama-local" as const,
  endpointUrl: "http://host.openshell.internal:11435/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "sentinel" as const,
  gatewayName: "nemoclaw",
  sandboxName: "alpha",
};
export const attachment = {
  ...binding,
  ...nativeLocalIdentity(binding),
  schemaVersion: 1 as const,
  providerId: "owned-local-provider",
};

export function fixture(selectedAttachment = attachment) {
  const config: ConfigObject = {
    agents: { defaults: { model: { primary: "inference/old-model" } } },
    models: {
      providers: {
        inference: {
          baseUrl: binding.endpointUrl,
          apiKey: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
          api: "openai-completions",
          models: [{ id: "old-model" }],
        },
      },
    },
  };
  return createDeps({
    config,
    entry: {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      provider: binding.provider,
      model: "old-model",
      endpointUrl: binding.endpointUrl,
      preferredInferenceApi: "openai-completions",
      nativeLocalProviderAttachment: selectedAttachment,
    },
  });
}

export function switchingFixture(
  previous = attachment,
  provider: "ollama-local" | "vllm-local" = "vllm-local",
) {
  const deps = fixture(previous);
  const nextBinding = {
    ...binding,
    provider,
    endpointUrl:
      provider === "ollama-local" ? binding.endpointUrl : "http://host.openshell.internal:8000/v1",
  };
  const next = {
    ...nextBinding,
    ...nativeLocalIdentity(nextBinding),
    schemaVersion: 1 as const,
    providerId: "new-local-provider",
  };
  let present = false;
  let attached = false;
  const authorities = new Map<string, NativeLocalProviderAttachment>();
  deps.getNativeLocalProviderAuthority = (name) => authorities.get(name);
  deps.setNativeLocalProviderAuthority = (receipt) => {
    authorities.set(receipt.providerName, receipt);
  };
  deps.resolveLocalSwitchRuntime = () => ({
    endpointUrl: next.endpointUrl,
    credentialValue: provider === "ollama-local" ? "ollama" : "dummy",
    authMode: "sentinel",
    ownedProxy: provider === "ollama-local",
  });
  const adapter = deps.providerAdapter;
  const original = { ...adapter };
  adapter.importProviderProfile = async () => ({ ok: true });
  adapter.inspectProviderProfile = async (request) =>
    request.profileType === next.profileId
      ? { ok: true, value: { credentialKeys: [next.credentialEnv] } }
      : original.inspectProviderProfile(request);
  adapter.getProvider = async (request) =>
    request.providerName === next.providerName
      ? present
        ? {
            ok: true,
            value: {
              name: next.providerName,
              type: next.profileId,
              credentialKeys: [next.credentialEnv],
              configKeys: [],
              revision: { id: next.providerId, resourceVersion: 1 },
            },
          }
        : { ok: false, error: { kind: "command", reason: "not_found", message: "not found" } }
      : original.getProvider(request);
  adapter.createProvider = async (request) => {
    if (request.name !== next.providerName) return original.createProvider(request);
    present = true;
    return { ok: true };
  };
  adapter.attachProvider = async (request) => {
    if (request.providerName !== next.providerName) return original.attachProvider(request);
    attached = true;
    return { ok: true };
  };
  adapter.detachProvider = async (request) => {
    if (request.providerName !== next.providerName) return original.detachProvider(request);
    const changed = attached;
    attached = false;
    return { ok: true, value: { changed } };
  };
  adapter.listProviderAttachments = async (request) => {
    const result = await original.listProviderAttachments(request);
    return result.ok
      ? {
          ok: true,
          value: { names: [...result.value.names, ...(attached ? [next.providerName] : [])] },
        }
      : result;
  };
  adapter.deleteProvider = async (request) => {
    if (request.providerName !== next.providerName) return original.deleteProvider(request);
    present = false;
    return { ok: true };
  };
  return { deps, next, isPresent: () => present, isAttached: () => attached };
}
