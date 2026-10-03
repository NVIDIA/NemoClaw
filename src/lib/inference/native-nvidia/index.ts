// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  NativeHostedProviderError,
  ensureNativeHostedProvider,
  verifyNativeHostedProviderAttachment,
  ensureNativeHostedProviderAttached,
  detachNativeHostedProvider,
  normalizeNativeHostedProviderAttachment,
  type NativeHostedProviderAttachment,
} from "../native-hosted";
import { nativeHostedProfile } from "../native-hosted/profiles";

export const NVIDIA_HOSTED_LOGICAL_PROVIDER = "nvidia-prod";
export const NVIDIA_HOSTED_NATIVE_ENDPOINT = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_HOSTED_NATIVE_PROFILE_ID = "nemoclaw-nvidia-inference-v1";
export const NVIDIA_HOSTED_NATIVE_PROVIDER = "nemoclaw-nvidia-prod-v1";
export const NVIDIA_HOSTED_CREDENTIAL_ENV = "NVIDIA_INFERENCE_API_KEY";

// Preserve Slice 1's public helpers and persisted NVIDIA receipt while sharing its
// provider lifecycle with the other fixed hosted selections.
export type NativeNvidiaProviderAttachment = NativeHostedProviderAttachment;
export { NativeHostedProviderError as NativeNvidiaProviderError };

const profile = nativeHostedProfile(NVIDIA_HOSTED_LOGICAL_PROVIDER)!;

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

export function nativeInferenceProviderForSandbox(
  provider: string | null | undefined,
): string | null {
  const normalized = provider?.trim() || null;
  return isNativeNvidiaProvider(normalized) ? NVIDIA_HOSTED_NATIVE_PROVIDER : normalized;
}

export function normalizeNativeNvidiaProviderAttachment(
  value: unknown,
): NativeNvidiaProviderAttachment | undefined {
  const receipt = normalizeNativeHostedProviderAttachment(value);
  return receipt?.profileId === NVIDIA_HOSTED_NATIVE_PROFILE_ID ? receipt : undefined;
}

export function ensureNativeNvidiaProvider(
  input: Omit<Parameters<typeof ensureNativeHostedProvider>[0], "profile">,
): ReturnType<typeof ensureNativeHostedProvider> {
  return ensureNativeHostedProvider({ ...input, profile });
}

export function verifyNativeNvidiaProviderAttachment(
  input: Omit<Parameters<typeof verifyNativeHostedProviderAttachment>[0], "profile">,
): ReturnType<typeof verifyNativeHostedProviderAttachment> {
  return verifyNativeHostedProviderAttachment({ ...input, profile });
}

export function ensureNativeNvidiaProviderAttached(
  input: Omit<Parameters<typeof ensureNativeHostedProviderAttached>[0], "profile">,
): ReturnType<typeof ensureNativeHostedProviderAttached> {
  return ensureNativeHostedProviderAttached({ ...input, profile });
}

export function detachNativeNvidiaProvider(
  input: Omit<Parameters<typeof detachNativeHostedProvider>[0], "profile">,
): ReturnType<typeof detachNativeHostedProvider> {
  return detachNativeHostedProvider({ ...input, profile });
}
