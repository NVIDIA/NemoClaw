// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../name-validation";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { isIP } from "node:net";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";
import { isLoopbackHostname, isPrivateIp } from "../../private-networks";
import {
  isOpenShellManagedHost,
  isOperatorTrustablePrivateIp,
} from "../../security/trusted-private-endpoint";
import {
  createNativeProviderLifecycle,
  type NativeProviderAttachment,
} from "../native-provider/lifecycle";
import { buildNativeCustomProfile, type NativeCustomProfile } from "./profile";
import {
  normalizeNativeCustomAdapterTransport,
  type NativeCustomAdapterTransport,
} from "./adapter-transport";

export { prepareNativeCustomProfile, isNativeCustomProvider } from "./profile";
export type { NativeCustomProfile, NativeCustomProvider, NativeCustomApi } from "./profile";

export class NativeCustomProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeCustomProviderError";
  }
}

export type NativeCustomProviderAttachment = NativeProviderAttachment &
  Readonly<{
    sandboxName: string;
    endpointUrl: string;
    api: NativeCustomProfile["api"];
    credentialEnv: string;
    addresses: readonly string[];
    trustedPrivateEndpoint: boolean;
    transport?: NativeCustomAdapterTransport;
  }>;

/** Keep the generated contract private and alive until profile import/verification finishes. */
export async function withNativeCustomLifecycle<T>(
  prepared: NativeCustomProfile,
  operation: (lifecycle: ReturnType<typeof createNativeProviderLifecycle>) => Promise<T>,
): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-profile-"));
  try {
    const profilePath = path.join(directory, `${prepared.profile.id}.yaml`);
    fs.writeFileSync(profilePath, YAML.stringify(prepared.profile), { mode: 0o600, flag: "wx" });
    return await operation(
      createNativeProviderLifecycle(
        {
          profileId: prepared.profile.id,
          providerName: prepared.providerName,
          credentialEnv: prepared.credentialEnv,
          logicalProvider:
            prepared.credentialEnv === "COMPATIBLE_API_KEY"
              ? "compatible-endpoint"
              : "compatible-anthropic-endpoint",
          profilePath,
          label: "custom hosted",
        },
        NativeCustomProviderError,
      ),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function customAttachmentFromPrepared(
  prepared: NativeCustomProfile,
  receipt: NativeProviderAttachment,
): NativeCustomProviderAttachment {
  if (
    receipt.profileId !== prepared.profile.id ||
    receipt.providerName !== prepared.providerName ||
    !receipt.providerId
  ) {
    throw new NativeCustomProviderError(
      "Custom provider identity does not match the validated endpoint contract.",
    );
  }
  return {
    ...receipt,
    sandboxName: prepared.sandboxName,
    endpointUrl: prepared.endpointUrl,
    api: prepared.api,
    credentialEnv: prepared.credentialEnv,
    addresses: [...prepared.profile.endpoints[0].allowed_ips],
    trustedPrivateEndpoint: prepared.trustedPrivateEndpoint,
    ...(prepared.transport ? { transport: prepared.transport } : {}),
  };
}

/** Restore only a complete receipt whose identity binds its exact endpoint/API/address contract. */
export function normalizeNativeCustomProviderAttachment(
  value: unknown,
  sandboxName?: string,
): NativeCustomProviderAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.sandboxName !== "string" ||
    !isValidName(record.sandboxName) ||
    (sandboxName !== undefined && record.sandboxName !== sandboxName) ||
    typeof record.providerId !== "string" ||
    !record.providerId.trim() ||
    typeof record.endpointUrl !== "string" ||
    unsafeEndpointUrlViolation(record.endpointUrl) ||
    !["openai-completions", "openai-responses", "anthropic-messages"].includes(
      String(record.api),
    ) ||
    !["COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY"].includes(
      String(record.credentialEnv),
    ) ||
    typeof record.trustedPrivateEndpoint !== "boolean" ||
    !Array.isArray(record.addresses) ||
    (record.addresses.length === 0 && record.transport === undefined)
  )
    return undefined;
  try {
    const url = new URL(record.endpointUrl);
    const provider =
      record.credentialEnv === "COMPATIBLE_API_KEY"
        ? "compatible-endpoint"
        : "compatible-anthropic-endpoint";
    const transport =
      record.transport === undefined
        ? undefined
        : normalizeNativeCustomAdapterTransport(record.transport, {
            sandboxName: record.sandboxName,
            provider,
            api: String(record.api),
            endpointUrl: record.endpointUrl,
          });
    if (
      record.transport !== undefined &&
      (!transport || record.addresses.length !== 0 || record.trustedPrivateEndpoint)
    )
      return undefined;
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      isLoopbackHostname(url.hostname) ||
      (isOpenShellManagedHost(url.hostname) && !transport) ||
      /[*[\]{}\\]/u.test(url.pathname) ||
      /%2f|%5c/iu.test(url.pathname)
    )
      return undefined;
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (isIP(host) && (record.addresses.length !== 1 || record.addresses[0] !== host))
      return undefined;
    const addresses: string[] = [];
    for (const address of record.addresses) {
      if (
        typeof address !== "string" ||
        !isIP(address) ||
        (isPrivateIp(address) &&
          (!record.trustedPrivateEndpoint || !isOperatorTrustablePrivateIp(address)))
      )
        return undefined;
      addresses.push(address);
    }
    const prepared = {
      ...buildNativeCustomProfile({
        sandboxName: record.sandboxName,
        provider:
          record.credentialEnv === "COMPATIBLE_API_KEY"
            ? "compatible-endpoint"
            : "compatible-anthropic-endpoint",
        endpointUrl: record.endpointUrl,
        api: record.api as NativeCustomProfile["api"],
        addresses,
        ...(transport ? { transport } : {}),
      }),
      trustedPrivateEndpoint: record.trustedPrivateEndpoint,
    };
    if (record.profileId !== prepared.profile.id || record.providerName !== prepared.providerName)
      return undefined;
    return customAttachmentFromPrepared(prepared, {
      schemaVersion: 1,
      profileId: prepared.profile.id,
      providerName: prepared.providerName,
      providerId: record.providerId,
    });
  } catch {
    return undefined;
  }
}

export function profileFromCustomAttachment(
  value: NativeCustomProviderAttachment,
): NativeCustomProfile {
  const receipt = normalizeNativeCustomProviderAttachment(value);
  if (!receipt)
    throw new NativeCustomProviderError("Invalid native custom inference attachment authority.");
  return {
    ...buildNativeCustomProfile({
      sandboxName: receipt.sandboxName,
      provider:
        receipt.credentialEnv === "COMPATIBLE_API_KEY"
          ? "compatible-endpoint"
          : "compatible-anthropic-endpoint",
      endpointUrl: receipt.endpointUrl,
      api: receipt.api,
      addresses: receipt.addresses,
      ...(receipt.transport ? { transport: receipt.transport } : {}),
    }),
    trustedPrivateEndpoint: receipt.trustedPrivateEndpoint,
  };
}

export async function verifyNativeCustomProviderAttachment(input: {
  adapter: import("../../adapters/openshell/provider-adapter").OpenShellProviderAdapter;
  target: import("../../adapters/openshell/sandbox-observer").OpenShellGatewayTarget;
  sandboxName: string;
  expected: NativeCustomProviderAttachment;
}): Promise<NativeCustomProviderAttachment> {
  const prepared = profileFromCustomAttachment(input.expected);
  if (
    prepared.transport &&
    (input.target.kind !== "named" || input.target.gatewayName !== prepared.transport.gatewayName)
  )
    throw new NativeCustomProviderError(
      "Native custom adapter authority belongs to another gateway.",
    );
  if (prepared.sandboxName !== input.sandboxName)
    throw new NativeCustomProviderError(
      "Native custom provider authority belongs to another sandbox.",
    );
  const receipt = await withNativeCustomLifecycle(prepared, (lifecycle) =>
    lifecycle.verifyProviderAttachment(input),
  );
  return customAttachmentFromPrepared(prepared, receipt);
}

export async function ensureNativeCustomProviderAttached(
  input: Parameters<typeof verifyNativeCustomProviderAttachment>[0],
) {
  const prepared = profileFromCustomAttachment(input.expected);
  if (
    prepared.transport &&
    (input.target.kind !== "named" || input.target.gatewayName !== prepared.transport.gatewayName)
  )
    throw new NativeCustomProviderError(
      "Native custom adapter authority belongs to another gateway.",
    );
  if (prepared.sandboxName !== input.sandboxName)
    throw new NativeCustomProviderError(
      "Native custom provider authority belongs to another sandbox.",
    );
  return withNativeCustomLifecycle(prepared, async (lifecycle) => {
    const attached = await lifecycle.ensureProviderAttached(input);
    return { ...attached, receipt: customAttachmentFromPrepared(prepared, attached.receipt) };
  });
}

export async function detachNativeCustomProvider(
  input: Parameters<typeof verifyNativeCustomProviderAttachment>[0],
): Promise<void> {
  const prepared = profileFromCustomAttachment(input.expected);
  if (
    prepared.transport &&
    (input.target.kind !== "named" || input.target.gatewayName !== prepared.transport.gatewayName)
  )
    throw new NativeCustomProviderError(
      "Native custom adapter authority belongs to another gateway.",
    );
  if (prepared.sandboxName !== input.sandboxName)
    throw new NativeCustomProviderError(
      "Native custom provider authority belongs to another sandbox.",
    );
  return withNativeCustomLifecycle(prepared, (lifecycle) => lifecycle.detachProvider(input));
}
