// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NativeHostedProfile } from "../native-hosted/profiles";

/** Consume only the identity-bound handle OpenShell issued inside the workload. */
export function nativeInferenceProbeAuthScript(
  credentialEnv: NativeHostedProfile["credentialEnv"],
  anthropic = false,
): string[] {
  const pattern = `^openshell:resolve:env:(v[0-9]+|s[0-9a-f]{64})_${credentialEnv}$`;
  return [
    `native_handle="\${${credentialEnv}:-}"`,
    // Reject control characters as well as real keys and unversioned aliases.
    `case "$native_handle" in *[!a-zA-Z0-9:_]*) printf 'credential-handle-unavailable\\n'; exit 1 ;; esac`,
    `printf '%s' "$native_handle" | LC_ALL=C grep -Eq '${pattern}' || { printf 'credential-handle-unavailable\\n'; exit 1; }`,
    `AUTH_HEADER='${anthropic ? "x-api-key: " : "Authorization: Bearer "}'"$native_handle"`,
  ];
}
