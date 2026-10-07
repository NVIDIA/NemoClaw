// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NATIVE_LOCAL_CREDENTIAL_ENV = "NEMOCLAW_LOCAL_INFERENCE_TOKEN";

/** Select the opaque credential reference for a qualified local agent endpoint. */
export function nativeLocalCredentialReference(
  provider: string | null | undefined,
  endpointUrl: string,
): string | null {
  if (
    !["ollama-local", "vllm-local", "llama-cpp-local", "compatible-endpoint"].includes(
      provider ?? "",
    )
  )
    return null;
  try {
    const endpoint = new URL(endpointUrl);
    const host = endpoint.hostname;
    const privateIpv4 =
      /^10\.\d+\.\d+\.\d+$/.test(host) ||
      /^192\.168\.\d+\.\d+$/.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/.test(host);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.username ||
      endpoint.password ||
      (!privateIpv4 && host !== "host.openshell.internal" && host !== "host.docker.internal")
    )
      return null;
    return `openshell:resolve:env:${NATIVE_LOCAL_CREDENTIAL_ENV}`;
  } catch {
    return null;
  }
}
