// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import { parseTrustedPrivateInferenceHostsFromEnv } from "../endpoint-ssrf-preflight";
import fs from "node:fs";
import { isIP } from "node:net";
import {
  normalizeNativeCompatibleProviderAttachment,
  type NativeCompatibleProviderAttachment,
} from "./contract";
import os from "node:os";
import path from "node:path";
import type {
  OpenShellGatewayTarget,
  OpenShellProviderAdapter,
} from "../../adapters/openshell/sandbox-observer";
import { prepareNativeCompatibleEndpoint } from "./endpoint";
import {
  ensureNativeProviderAttached,
  detachNativeProvider,
  verifyNativeProviderAttachment,
  ensureNativeProvider,
  type NativeProviderAttachment,
} from "../native-provider/lifecycle";

export async function prepareNativeCompatibleProfile(
  input: Parameters<typeof prepareNativeCompatibleEndpoint>[0],
) {
  const endpoint = await prepareNativeCompatibleEndpoint(input);
  const anthropic = endpoint.api === "anthropic-messages";
  const credentialEnv = "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY";
  return {
    ...endpoint,
    credentialEnv,
    document: {
      id: endpoint.profileId,
      display_name: "NemoClaw Compatible Hosted Inference",
      description: "Native inference restricted to one validated endpoint and API",
      category: "inference",
      credentials: [
        {
          name: "api_key",
          description: "Compatible hosted inference API key",
          env_vars: [credentialEnv],
          required: true,
          auth_style: anthropic ? "header" : "bearer",
          header_name: anthropic ? "x-api-key" : "authorization",
          query_param: "",
        },
      ],
      endpoints: [
        {
          host: endpoint.host,
          port: endpoint.port,
          protocol: "rest",
          enforcement: "enforce",
          allowed_ips: endpoint.addresses,
          rules: [
            { allow: { method: "GET", path: endpoint.modelsPath } },
            { allow: { method: "POST", path: endpoint.inferencePath } },
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

/** Import only after validation; the existing adapter refuses an incompatible live profile. */
export async function ensureNativeCompatibleProfile(
  input: Parameters<typeof prepareNativeCompatibleEndpoint>[0] & {
    adapter: Pick<OpenShellProviderAdapter, "importProviderProfile">;
    target: OpenShellGatewayTarget;
  },
) {
  const profile = await prepareNativeCompatibleProfile(input);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-profile-"));
  try {
    const profilePath = path.join(directory, "profile.yaml");
    // JSON is valid YAML and preserves URL characters without interpolation.
    fs.writeFileSync(profilePath, JSON.stringify(profile.document), { mode: 0o600 });
    const imported = await input.adapter.importProviderProfile({
      target: input.target,
      profilePath,
    });
    if (!imported.ok) {
      throw new Error(
        "OpenShell did not confirm the endpoint-specific profile. No provider was activated.",
      );
    }
    return profile;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Create or reconcile an owned provider without placing its credential in the profile. */
export async function ensureNativeCompatibleProvider(
  input: Parameters<typeof prepareNativeCompatibleEndpoint>[0] & {
    adapter: OpenShellProviderAdapter;
    target: OpenShellGatewayTarget;
    credentialValue: string | null;
    expected?: NativeProviderAttachment;
    resolveExpected?: (profileId: string) => NativeProviderAttachment | undefined;
  },
) {
  const profile = await prepareNativeCompatibleProfile({
    ...input,
    trust: input.trust ?? {
      trustedPrivateHosts: parseTrustedPrivateInferenceHostsFromEnv(process.env),
    },
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-profile-"));
  try {
    const profilePath = path.join(directory, "profile.yaml");
    fs.writeFileSync(profilePath, JSON.stringify(profile.document), { mode: 0o600 });
    const receipt = await ensureNativeProvider({
      adapter: input.adapter,
      target: input.target,
      credentialValue: input.credentialValue,
      expected: input.resolveExpected?.(profile.profileId) ?? input.expected,
      profile: { ...profile, label: "compatible hosted", profilePath },
    });
    return {
      ...receipt,
      endpointUrl: profile.endpoint,
      api: profile.api,
      addresses: profile.addresses,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function ensureNativeCompatibleProviderAttached(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: import("./contract").NativeCompatibleProviderAttachment;
  lookup?: Parameters<typeof prepareNativeCompatibleEndpoint>[0]["lookup"];
}) {
  const profile = await ensureNativeCompatibleProfile({
    ...input,
    endpointUrl: input.expected.endpointUrl,
    api: input.expected.api,
    lookup: retainedAddressLookup(input.expected),
    trust: { trustedPrivateHosts: parseTrustedPrivateInferenceHostsFromEnv(process.env) },
  });
  return ensureNativeProviderAttached({
    ...input,
    profile: { ...profile, profilePath: "", label: "compatible hosted" },
  });
}

/** Observe the security boundary and attachment without importing or changing a profile. */
export async function verifyNativeCompatibleProviderAttachment(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: import("./contract").NativeCompatibleProviderAttachment;
  lookup?: Parameters<typeof prepareNativeCompatibleEndpoint>[0]["lookup"];
}) {
  const profile = await prepareNativeCompatibleProfile({
    endpointUrl: input.expected.endpointUrl,
    api: input.expected.api,
    lookup: retainedAddressLookup(input.expected),
    trust: { trustedPrivateHosts: parseTrustedPrivateInferenceHostsFromEnv(process.env) },
  });
  const contract = parseCheckedInProviderProfileContract(JSON.stringify(profile.document));
  if (!contract) throw new Error("Native compatible provider profile could not be validated.");
  const observed = await input.adapter.inspectProviderProfile({
    target: input.target,
    profileType: profile.profileId,
    expectedProfile: contract,
  });
  if (!observed.ok)
    throw new Error("Native compatible provider profile does not match its endpoint boundary.");
  return verifyNativeProviderAttachment({
    ...input,
    profile: { ...profile, profilePath: "", label: "compatible hosted" },
  });
}

/** Remove only the endpoint-scoped provider identity recorded for this sandbox. */
export async function detachNativeCompatibleProvider(input: {
  adapter: OpenShellProviderAdapter;
  target: OpenShellGatewayTarget;
  sandboxName: string;
  expected: import("./contract").NativeCompatibleProviderAttachment;
}) {
  const expected = normalizeNativeCompatibleProviderAttachment(input.expected);
  if (!expected) throw new Error("Invalid native compatible ownership receipt.");
  return detachNativeProvider({
    ...input,
    expected,
    profile: {
      profileId: expected.profileId,
      providerName: expected.providerName,
      profilePath: "",
      credentialEnv: "NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY",
      label: "compatible hosted",
    },
  });
}

/** Observation must verify the issued boundary, not replace its pins with fresh DNS results. */
function retainedAddressLookup(value: NativeCompatibleProviderAttachment) {
  const receipt = normalizeNativeCompatibleProviderAttachment(value);
  if (!receipt) throw new Error("Invalid native compatible ownership receipt.");
  return async () => receipt.addresses.map((address) => ({ address, family: isIP(address) }));
}
