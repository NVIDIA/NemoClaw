// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureResolvedOpenshellAsync } from "../../adapters/openshell/runtime";
import { isValidName } from "../../name-validation";

export function isNativeCustomCredentialReference(value: string, key: string): boolean {
  return (
    ["COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY"].includes(key) &&
    new RegExp(`^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_${key}$`, "u").test(value)
  );
}

/** Return only the issued reference; never return raw sandbox credential material. */
export async function resolveNativeCustomCredentialReference(
  input: {
    sandboxName: string;
    gatewayName: string;
    credentialEnv: string;
  },
  capture = captureResolvedOpenshellAsync,
): Promise<string> {
  if (
    !isValidName(input.sandboxName) ||
    !isValidName(input.gatewayName) ||
    !["COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY"].includes(input.credentialEnv)
  )
    throw new Error("Invalid native custom credential scope.");
  const script = `printf '%s' "\${${input.credentialEnv}}"`;
  const result = await capture(
    ["sandbox", "exec", "-g", input.gatewayName, input.sandboxName, "--", "sh", "-lc", script],
    { ignoreError: true, timeout: 15_000 },
  );
  const value = (result.stdout ?? "").trim();
  if (result.status !== 0 || !isNativeCustomCredentialReference(value, input.credentialEnv))
    throw new Error(
      "Native custom inference has no matching supervisor-issued credential reference.",
    );
  return value;
}
