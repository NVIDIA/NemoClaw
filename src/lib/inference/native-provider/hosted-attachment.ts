// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeNativeProviderAttachment, type NativeProviderAttachment } from "./contract";
import {
  HOSTED_NATIVE_PROVIDERS,
  hostedNativeProvider,
  type HostedProviderDefinition,
} from "./hosted";

export function hostedNativeProviderForAttachment(
  value: unknown,
): HostedProviderDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  for (const fixed of HOSTED_NATIVE_PROVIDERS) {
    let definition: HostedProviderDefinition;
    try {
      definition = hostedNativeProvider(
        fixed.logicalProvider,
        fixed.logicalProvider === "hermes-provider" && typeof receipt.endpointUrl === "string"
          ? receipt.endpointUrl
          : undefined,
      )!;
    } catch {
      continue;
    }
    if (normalizeNativeProviderAttachment(value, definition)) return definition;
  }
  return undefined;
}

export function normalizeHostedProviderAttachment(
  value: unknown,
): NativeProviderAttachment | undefined {
  const definition = hostedNativeProviderForAttachment(value);
  return definition ? normalizeNativeProviderAttachment(value, definition) : undefined;
}

export function requireHostedProviderAttachment(
  value: unknown,
  provider: string | null | undefined,
): NativeProviderAttachment | undefined {
  if (value === undefined) return undefined;
  const definition = hostedNativeProviderForAttachment(value);
  const receipt =
    definition && definition.logicalProvider === provider?.trim()
      ? normalizeNativeProviderAttachment(value, definition)
      : undefined;
  if (!receipt)
    throw new Error("Invalid native hosted provider attachment for the selected provider");
  return receipt;
}

export function isNativeHostedProviderName(name: string | null | undefined): boolean {
  return (
    !!name &&
    (HOSTED_NATIVE_PROVIDERS.some((definition) => definition.providerName === name) ||
      /^nemoclaw-hermes-[a-f0-9]{20}-v1$/u.test(name))
  );
}

/** Match a fixed resource name when no endpoint-bound attachment was recorded. */
export function hostedNativeProviderForName(name: string): HostedProviderDefinition | undefined {
  return HOSTED_NATIVE_PROVIDERS.find((entry) => entry.providerName === name);
}
