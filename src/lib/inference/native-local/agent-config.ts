// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety.ts";

export const NATIVE_LOCAL_CREDENTIAL_ENV = "NEMOCLAW_LOCAL_INFERENCE_TOKEN";

/** The endpoint shape shared by local provider registration and agent credentials. */
export function qualifiedNativeLocalEndpointUrl(endpointUrl: string): string | null {
  if (!endpointUrl || unsafeEndpointUrlViolation(endpointUrl)) return null;
  try {
    const endpoint = new URL(endpointUrl);
    const host = endpoint.hostname;
    const privateIpv4 =
      isIP(host) === 4 &&
      (host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host));
    if (
      endpoint.protocol !== "http:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.port ||
      Number(endpoint.port) < 1024 ||
      (host !== "host.openshell.internal" && host !== "host.docker.internal" && !privateIpv4) ||
      !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/.test(endpoint.pathname)
    )
      return null;
    return `${endpoint.origin}${endpoint.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

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
  return qualifiedNativeLocalEndpointUrl(endpointUrl)
    ? `openshell:resolve:env:${NATIVE_LOCAL_CREDENTIAL_ENV}`
    : null;
}

/** Endpoint-bound credentials require a supervisor-issued revision or stable identity. */
export const NATIVE_LOCAL_RUNTIME_REFERENCE_PATTERN =
  "^openshell:resolve:env:(v[0-9]{1,20}|s[a-f0-9]{64})_NEMOCLAW_LOCAL_INFERENCE_TOKEN$";

// Validate the entire environment value before emitting anything. In particular,
// grep alone would accept one valid line embedded in a multiline raw credential.
export const NATIVE_LOCAL_SCOPED_HANDLE_READ_SCRIPT = [
  'if [ -z "${NEMOCLAW_LOCAL_INFERENCE_TOKEN:-}" ]; then printf "%s\\n" NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING >&2; exit 75; fi',
  'case "$NEMOCLAW_LOCAL_INFERENCE_TOKEN" in *[!a-zA-Z0-9:_]*) exit 2 ;; esac',
  `printf "%s" "$NEMOCLAW_LOCAL_INFERENCE_TOKEN" | LC_ALL=C grep -Eq "${NATIVE_LOCAL_RUNTIME_REFERENCE_PATTERN}" || exit 2`,
  'printf "%s" "$NEMOCLAW_LOCAL_INFERENCE_TOKEN"',
].join("; ");
