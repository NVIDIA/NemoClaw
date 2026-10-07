// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/sandbox-observer";
import { BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV } from "../bedrock-runtime";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import { verifyBedrockRuntimeAdapterGeneration } from "../bedrock-runtime-adapter";
import {
  detachNativeProvider,
  ensureNativeProviderAttached,
  verifyNativeProviderAttachment,
  ensureNativeProvider,
  persistNativeProviderAuthority,
} from "../native-provider/lifecycle";
import {
  nativeBedrockIdentity,
  normalizeNativeBedrockProviderAttachment,
  type NativeBedrockBinding,
  type NativeBedrockProviderAttachment,
} from "./contract";

/** This fixed private bridge is not a user-supplied HTTP destination. */
export function prepareNativeBedrockProfile(binding: NativeBedrockBinding) {
  const identity = nativeBedrockIdentity(binding);
  const endpoint = new URL(binding.adapterBaseUrl);
  const credentialEnv = BEDROCK_RUNTIME_ADAPTER_PROVIDER_CREDENTIAL_ENV;
  return {
    ...identity,
    credentialEnv,
    document: {
      id: identity.profileId,
      display_name: "NemoClaw Bedrock Runtime Adapter",
      description: "Inference restricted to a verified Bedrock adapter generation",
      category: "inference",
      credentials: [
        {
          name: "api_key",
          env_vars: [credentialEnv],
          required: true,
          auth_style: "bearer",
          header_name: "authorization",
          query_param: "",
        },
      ],
      endpoints: [
        {
          host: endpoint.hostname,
          port: Number(endpoint.port || "80"),
          protocol: "rest",
          enforcement: "enforce",
          rules: [
            { allow: { method: "GET", path: "/v1/models" } },
            { allow: { method: "POST", path: "/v1/chat/completions" } },
          ],
        },
      ],
      binaries: [
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/opt/hermes/.venv/bin/python",
        "/opt/hermes/.venv/bin/python3",
        "/opt/venv/bin/python3",
        "/usr/local/bin/curl",
        "/usr/bin/curl",
      ],
      inference_capable: true,
    },
  };
}

/** The caller supplies generation evidence obtained from the verified adapter lifecycle. */
export async function ensureNativeBedrockProvider(input: {
  binding: NativeBedrockBinding;
  adapter: OpenShellProviderAdapter;
  credentialValue: string | null;
  expected?: NativeBedrockProviderAttachment;
  authority?: {
    gatewayName: string;
    read: (profileId: string) => NativeBedrockProviderAttachment | undefined;
    write: (receipt: NativeBedrockProviderAttachment) => void;
  };
}): Promise<NativeBedrockProviderAttachment> {
  const profile = prepareNativeBedrockProfile(input.binding);
  const expected = input.expected && normalizeNativeBedrockProviderAttachment(input.expected);
  if (input.expected && !expected) throw new Error("Invalid native Bedrock ownership receipt.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bedrock-profile-"));
  try {
    const profilePath = path.join(directory, "profile.yaml");
    fs.writeFileSync(profilePath, JSON.stringify(profile.document), { mode: 0o600 });
    const receipt = await ensureNativeProvider({
      adapter: input.adapter,
      target: { kind: "named", gatewayName: input.binding.gatewayName },
      credentialValue: input.credentialValue,
      expected,
      profile: { ...profile, profilePath, label: "Bedrock adapter" },
    });
    const attachment = {
      ...receipt,
      endpointUrl: input.binding.endpointUrl,
      region: input.binding.region,
      adapterGeneration: input.binding.adapterGeneration,
      adapterBaseUrl: input.binding.adapterBaseUrl,
      gatewayName: input.binding.gatewayName,
    };
    if (input.authority) {
      const authority = input.authority;
      await persistNativeProviderAuthority({
        profile: { ...profile, profilePath, label: "Bedrock adapter" },
        adapter: input.adapter,
        target: { kind: "named" as const, gatewayName: input.binding.gatewayName },
        gatewayName: authority.gatewayName,
        receipt: attachment,
        existing: expected,
        readAuthority: () => authority.read(profile.profileId),
        writeAuthority: () => authority.write(attachment),
        recoveryGuidance: "Inspect provider ownership before retrying the command.",
      });
    }
    return attachment;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

type AttachmentInput = {
  adapter: OpenShellProviderAdapter;
  sandboxName: string;
  expected: NativeBedrockProviderAttachment;
  verifyAdapterGeneration?: typeof verifyBedrockRuntimeAdapterGeneration;
};

async function checkedAttachmentProfile(input: AttachmentInput) {
  const expected = normalizeNativeBedrockProviderAttachment(input.expected);
  if (!expected) throw new Error("Invalid native Bedrock ownership receipt.");
  await (input.verifyAdapterGeneration ?? verifyBedrockRuntimeAdapterGeneration)(expected);
  const profile = prepareNativeBedrockProfile(expected);
  const contract = parseCheckedInProviderProfileContract(JSON.stringify(profile.document));
  if (!contract) throw new Error("Native Bedrock provider profile could not be validated.");
  const target = { kind: "named" as const, gatewayName: expected.gatewayName };
  const observed = await input.adapter.inspectProviderProfile({
    target,
    profileType: profile.profileId,
    expectedProfile: contract,
  });
  if (!observed.ok)
    throw new Error("Native Bedrock provider profile does not match its adapter boundary.");
  return { target, expected, profile: { ...profile, profilePath: "", label: "Bedrock adapter" } };
}

export async function ensureNativeBedrockProviderAttached(input: AttachmentInput) {
  const checked = await checkedAttachmentProfile(input);
  return ensureNativeProviderAttached({ ...input, ...checked });
}

export async function verifyNativeBedrockProviderAttachment(input: AttachmentInput) {
  const checked = await checkedAttachmentProfile(input);
  return verifyNativeProviderAttachment({ ...input, ...checked });
}

/** Detach only the recorded identity; unavailable host adapters do not authorize replacement. */
export async function detachNativeBedrockProvider(input: {
  adapter: OpenShellProviderAdapter;
  sandboxName: string;
  expected: NativeBedrockProviderAttachment;
}) {
  const expected = normalizeNativeBedrockProviderAttachment(input.expected);
  if (!expected) throw new Error("Invalid native Bedrock ownership receipt.");
  const profile = prepareNativeBedrockProfile(expected);
  const contract = parseCheckedInProviderProfileContract(JSON.stringify(profile.document));
  if (!contract) throw new Error("Native Bedrock provider profile could not be validated.");
  const observed = await input.adapter.inspectProviderProfile({
    target: { kind: "named", gatewayName: expected.gatewayName },
    profileType: profile.profileId,
    expectedProfile: contract,
  });
  if (!observed.ok)
    throw new Error("Native Bedrock provider profile does not match its adapter boundary.");
  return detachNativeProvider({
    ...input,
    expected,
    target: { kind: "named", gatewayName: expected.gatewayName },
    profile: { ...profile, profilePath: "", label: "Bedrock adapter" },
  });
}
