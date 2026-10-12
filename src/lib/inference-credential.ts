// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The initial agent config expands this reference from the supervisor-issued,
// scoped OpenShell handle. An OpenClaw inference switch materializes that handle
// in its fresh sandbox exec before restarting the older gateway process. A
// static resolver alias has no provider identity and is rejected by the
// endpoint-bound native provider.
export const NVIDIA_INFERENCE_PLACEHOLDER = "${NVIDIA_INFERENCE_API_KEY}";

export function managedInferenceApiKey<T extends string>(
  baseUrl: string,
  fallback: T,
): T | typeof NVIDIA_INFERENCE_PLACEHOLDER {
  // Match the unnormalized URL, as startup and the Hermes policy reader do.
  // URL parsing would silently accept empty ports, dot segments and encoded hosts.
  const route = baseUrl.replace(/^[^/]+:\/\/[^/]+/u, (authority) => authority.toLowerCase());
  if (/^https:\/\/integrate\.api\.nvidia\.com(?::0*443)?\/v1\/?(?![\s\S])/u.test(route)) {
    return NVIDIA_INFERENCE_PLACEHOLDER;
  }
  if (/^https:\/\/integrate\.api\.nvidia\.com(?::(?:0*443)?)?(?:[/?#]|(?![\s\S]))/u.test(route)) {
    throw new Error("Native NVIDIA inference requires https://integrate.api.nvidia.com/v1.");
  }
  return fallback;
}
