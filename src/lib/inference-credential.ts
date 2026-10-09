// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The native provider rewrites references to its host-held credential. The
// inference.local route instead replaces the client's authorization header.
export const NVIDIA_INFERENCE_PLACEHOLDER = "sk-OPENSHELL-RESOLVE-ENV-NVIDIA_INFERENCE_API_KEY";

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
