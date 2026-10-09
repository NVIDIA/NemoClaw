// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Both agents expand this reference from the supervisor-issued, scoped
// OpenShell handle at config load. A static resolver alias has no provider
// identity and is rejected by the endpoint-bound native provider.
export const NVIDIA_INFERENCE_PLACEHOLDER = "${NVIDIA_INFERENCE_API_KEY}";

export function managedInferenceApiKey<T extends string>(
  baseUrl: string,
  fallback: T,
): T | typeof NVIDIA_INFERENCE_PLACEHOLDER {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol === "https:" &&
      url.hostname === "integrate.api.nvidia.com" &&
      url.port === "" &&
      (url.pathname === "/v1" || url.pathname === "/v1/") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    ) {
      return NVIDIA_INFERENCE_PLACEHOLDER;
    }
  } catch {
    // URL validation belongs to the route owner.
  }
  return fallback;
}
