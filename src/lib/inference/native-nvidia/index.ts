// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { createNativeProviderLifecycle } from "../native-provider/lifecycle";

import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  type NativeNvidiaProviderAttachment,
} from "./contract";

export {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  normalizeNativeNvidiaProviderAttachment,
  type NativeNvidiaProviderAttachment,
} from "./contract";

export class NativeNvidiaProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeNvidiaProviderError";
  }
}

export function nativeNvidiaProviderProfilePath(root = REPOSITORY_ROOT): string {
  return path.join(
    root,
    "managed-inference",
    "provider-profiles",
    `${NVIDIA_HOSTED_NATIVE_PROFILE_ID}.yaml`,
  );
}

export function isNativeNvidiaProvider(provider: string | null | undefined): boolean {
  return provider?.trim() === NVIDIA_HOSTED_LOGICAL_PROVIDER;
}

export function resolveGatewayNativeNvidiaProviderAuthority(input: {
  gatewayName: string;
  gatewayAuthority?: NativeNvidiaProviderAttachment | null;
  recordedAttachment?: NativeNvidiaProviderAttachment | null;
}): NativeNvidiaProviderAttachment | undefined {
  const authorities = new Map<string, NativeNvidiaProviderAttachment>();
  for (const receipt of [input.gatewayAuthority, input.recordedAttachment]) {
    if (receipt) authorities.set(receipt.providerId, receipt);
  }
  if (authorities.size > 1) {
    throw new NativeNvidiaProviderError(
      `Gateway '${input.gatewayName}' has conflicting native NVIDIA provider ownership receipts. No provider was changed.`,
    );
  }
  return authorities.values().next().value;
}

export function nativeInferenceProviderForSandbox(
  provider: string | null | undefined,
): string | null {
  const normalized = provider?.trim() || null;
  return isNativeNvidiaProvider(normalized) ? NVIDIA_HOSTED_NATIVE_PROVIDER : normalized;
}

const lifecycle = createNativeProviderLifecycle(
  {
    profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
    credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
    logicalProvider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
    profilePath: nativeNvidiaProviderProfilePath(),
    label: "NVIDIA",
  },
  NativeNvidiaProviderError,
);

export const nativeNvidiaProviderAttachmentFromMetadata = lifecycle.attachmentFromMetadata;
export const persistNativeNvidiaProviderAuthority = lifecycle.persistProviderAuthority;
export const ensureNativeNvidiaProvider = lifecycle.ensureProvider;
export const verifyNativeNvidiaProviderAttachment = lifecycle.verifyProviderAttachment;
export const ensureNativeNvidiaProviderAttached = lifecycle.ensureProviderAttached;
export const detachNativeNvidiaProvider = lifecycle.detachProvider;

export {
  isNativeNvidiaCredentialReference,
  resolveNativeNvidiaCredentialReference,
} from "./credential-reference";
