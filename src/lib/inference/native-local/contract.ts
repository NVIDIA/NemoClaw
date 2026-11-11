// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeLocalProviderAttachment,
  type NativeLocalProviderAttachment,
} from "./attachment";

export {
  usesNativeLocalInference,
  usesNativeLocalInferenceForAgent,
  isPersistedPiSharedLocalInferenceRoute,
} from "./eligibility";
export {
  NATIVE_LOCAL_CREDENTIAL_ENV,
  isLocalInferenceProvider,
  nativeLocalCredentialReference,
} from "./agent-config";
export {
  nativeLocalIdentity,
  normalizeNativeLocalBinding,
  normalizeNativeLocalProviderAttachment,
  type NativeLocalProvider,
  type NativeLocalBinding,
  type NativeLocalProviderAttachment,
} from "./attachment";

export function normalizeNativeLocalProviderAuthorities(
  value: unknown,
): Record<string, NativeLocalProviderAttachment> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Invalid persisted native local provider authority. Retain the registry for explicit repair.",
    );
  const entries = Object.entries(value).map(([name, value]) => {
    const receipt = normalizeNativeLocalProviderAttachment(value);
    if (!receipt || receipt.providerName !== name)
      throw new Error(
        "Invalid persisted native local provider authority. Retain the registry for explicit repair.",
      );
    return [name, receipt] as const;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
