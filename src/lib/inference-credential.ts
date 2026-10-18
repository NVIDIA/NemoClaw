// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The initial agent config expands this reference from the supervisor-issued,
// scoped OpenShell handle. An OpenClaw inference switch materializes that handle
// in its fresh sandbox exec before restarting the older gateway process. A
// static resolver alias has no provider identity and is rejected by the
// endpoint-bound native provider.
export const NVIDIA_INFERENCE_PLACEHOLDER = "${NVIDIA_INFERENCE_API_KEY}";
export const NATIVE_NVIDIA_SCOPED_HANDLE_PATTERN =
  /^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_NVIDIA_INFERENCE_API_KEY$/u;

// Emit only a provider-bound handle. A raw credential can never reach stdout.
export const NATIVE_NVIDIA_SCOPED_HANDLE_READ_SCRIPT =
  'if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then printf "%s\\n" NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING >&2; exit 75; fi; printf "%s" "$NVIDIA_INFERENCE_API_KEY" | LC_ALL=C grep -E "^openshell:resolve:env:(v[0-9]{1,20}|s[a-f0-9]{64})_NVIDIA_INFERENCE_API_KEY$"';

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
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return fallback;
  }
  if (
    parsed.protocol === "https:" &&
    parsed.hostname.replace(/\.+$/u, "") === "integrate.api.nvidia.com" &&
    parsed.port === ""
  ) {
    throw new Error("Native NVIDIA inference requires https://integrate.api.nvidia.com/v1.");
  }
  return fallback;
}
