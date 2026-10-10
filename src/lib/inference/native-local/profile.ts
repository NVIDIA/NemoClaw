// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requireNativeProviderPolicy } from "../../adapters/openshell/provider-policy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/sandbox-observer";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import {
  detachNativeProvider,
  retireNativeProvider,
  ensureNativeProvider,
  ensureNativeProviderAttached,
  persistNativeProviderAuthority,
  verifyNativeProviderAttachment,
} from "../native-provider/lifecycle";
import {
  nativeLocalIdentity,
  normalizeNativeLocalBinding,
  normalizeNativeLocalProviderAttachment,
  type NativeLocalBinding,
  type NativeLocalProviderAttachment,
} from "./contract";

export { normalizeNativeLocalProviderAttachment };

export function prepareNativeLocalProfile(input: NativeLocalBinding) {
  const binding = normalizeNativeLocalBinding(input);
  if (!binding) throw new Error("Invalid native host-local inference boundary.");
  const identity = nativeLocalIdentity(binding);
  const endpoint = new URL(binding.endpointUrl);
  return {
    ...identity,
    credentialEnv: binding.credentialEnv,
    document: {
      id: identity.profileId,
      display_name: "NemoClaw local inference",
      description: `Selected ${binding.authMode} host-local inference endpoint`,
      category: "inference",
      // Existing nonsecret sentinels satisfy the current provider store contract
      // for unauthenticated upstreams. They are never replaced with a host API key.
      credentials: [
        {
          name: "api_key",
          env_vars: [binding.credentialEnv],
          required: true,
          auth_style: "bearer",
          header_name: "authorization",
          query_param: "",
        },
      ],
      endpoints: [
        {
          host: endpoint.hostname,
          port: Number(endpoint.port),
          protocol: "rest",
          enforcement: "enforce",
          // The bridge uses the existing qualified runtime address. These ranges
          // admit its private resolution, never another hostname or port.
          allowed_ips: isIP(endpoint.hostname)
            ? [`${endpoint.hostname}/32`]
            : ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
          rules: [
            { allow: { method: "GET", path: `${endpoint.pathname}/models` } },
            { allow: { method: "POST", path: `${endpoint.pathname}/chat/completions` } },
          ],
        },
      ],
      binaries: [
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/usr/bin/python3",
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

export async function ensureNativeLocalProvider(input: {
  binding: NativeLocalBinding;
  adapter: OpenShellProviderAdapter;
  credentialValue: string | null;
  policyCommand?: Parameters<typeof requireNativeProviderPolicy>[1];
  expected?: NativeLocalProviderAttachment;
  readAuthority: (providerName: string) => NativeLocalProviderAttachment | undefined;
  writeAuthority: (receipt: NativeLocalProviderAttachment) => void;
}): Promise<NativeLocalProviderAttachment> {
  const binding = normalizeNativeLocalBinding(input.binding);
  if (!binding) throw new Error("Invalid native host-local inference boundary.");
  await requireNativeProviderPolicy(binding.gatewayName, input.policyCommand);
  const prepared = prepareNativeLocalProfile(binding);
  const expected = input.expected && normalizeNativeLocalProviderAttachment(input.expected);
  if (input.expected && !expected)
    throw new Error("Invalid native local provider ownership receipt.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-profile-"));
  try {
    const profilePath = path.join(directory, "profile.yaml");
    fs.writeFileSync(profilePath, JSON.stringify(prepared.document), { mode: 0o600 });
    const profile = { ...prepared, profilePath, label: "host-local" };
    const target = { kind: "named" as const, gatewayName: binding.gatewayName };
    const receipt = await ensureNativeProvider({ ...input, profile, target, expected });
    const attachment: NativeLocalProviderAttachment = { ...receipt, ...binding };
    await persistNativeProviderAuthority({
      adapter: input.adapter,
      profile,
      target,
      gatewayName: binding.gatewayName,
      receipt: attachment,
      existing: expected,
      readAuthority: () => input.readAuthority(prepared.providerName),
      writeAuthority: () => input.writeAuthority(attachment),
      recoveryGuidance: "Inspect native local provider ownership before retrying.",
    });
    return attachment;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

type AttachmentInput = {
  adapter: OpenShellProviderAdapter;
  sandboxName: string;
  expected: NativeLocalProviderAttachment;
};

async function checkedAttachment(input: AttachmentInput, requirePolicy = true) {
  const expected = normalizeNativeLocalProviderAttachment(input.expected);
  if (!expected || expected.sandboxName !== input.sandboxName)
    throw new Error("Native local provider ownership does not match the selected sandbox.");
  if (requirePolicy) await requireNativeProviderPolicy(expected.gatewayName);
  const prepared = prepareNativeLocalProfile(expected);
  const contract = parseCheckedInProviderProfileContract(JSON.stringify(prepared.document));
  if (!contract) throw new Error("Invalid native local provider profile.");
  const target = { kind: "named" as const, gatewayName: expected.gatewayName };
  const observed = await input.adapter.inspectProviderProfile({
    target,
    profileType: expected.profileId,
    expectedProfile: contract,
  });
  if (!observed.ok)
    throw new Error("Native local provider profile does not match its endpoint boundary.");
  return { expected, target, profile: { ...prepared, profilePath: "", label: "host-local" } };
}

export async function verifyNativeLocalProviderAttachment(input: AttachmentInput) {
  const checked = await checkedAttachment(input);
  await verifyNativeProviderAttachment({ ...input, ...checked });
  return checked.expected;
}

export async function ensureNativeLocalProviderAttached(input: AttachmentInput) {
  const checked = await checkedAttachment(input);
  const result = await ensureNativeProviderAttached({ ...input, ...checked });
  return { receipt: checked.expected, changed: result.changed };
}

export async function detachNativeLocalProvider(input: AttachmentInput) {
  const checked = await checkedAttachment(input, false);
  await detachNativeProvider({ ...input, ...checked });
}

/** Retire the exact instance after selection detaches it or its sandbox is confirmed absent. */
export async function retireNativeLocalProvider(input: {
  adapter: OpenShellProviderAdapter;
  expected: NativeLocalProviderAttachment;
  sandboxName: string;
  gatewayName: string;
  clearAuthority: (expected: NativeLocalProviderAttachment) => void;
}) {
  const expected = normalizeNativeLocalProviderAttachment(input.expected);
  if (
    !expected ||
    expected.sandboxName !== input.sandboxName ||
    expected.gatewayName !== input.gatewayName
  )
    throw new Error("Native local provider cleanup authority changed.");
  return retireNativeProvider({
    adapter: input.adapter,
    target: { kind: "named", gatewayName: expected.gatewayName },
    expected,
    credentialEnv: expected.credentialEnv,
    clearAuthority: () => input.clearAuthority(expected),
  });
}
