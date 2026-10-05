// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NVIDIA_HOSTED_LOGICAL_PROVIDER = "nvidia-prod";
export const NVIDIA_HOSTED_NATIVE_ENDPOINT = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_HOSTED_NATIVE_PROFILE_ID = "nemoclaw-nvidia-inference-v1";
export const NVIDIA_HOSTED_NATIVE_PROVIDER = "nemoclaw-nvidia-prod-v1";
export const NVIDIA_HOSTED_CREDENTIAL_ENV = "NVIDIA_INFERENCE_API_KEY";

export type NativeNvidiaProviderAttachment = Readonly<{
  schemaVersion: 1;
  profileId: typeof NVIDIA_HOSTED_NATIVE_PROFILE_ID;
  providerName: typeof NVIDIA_HOSTED_NATIVE_PROVIDER;
  providerId: string;
}>;

export function normalizeNativeNvidiaProviderAttachment(
  value: unknown,
): NativeNvidiaProviderAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.profileId !== NVIDIA_HOSTED_NATIVE_PROFILE_ID ||
    receipt.providerName !== NVIDIA_HOSTED_NATIVE_PROVIDER ||
    typeof receipt.providerId !== "string" ||
    !receipt.providerId.trim()
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
    providerId: receipt.providerId,
  };
}
