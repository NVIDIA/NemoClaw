// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isNativeProviderCredentialReference,
  resolveNativeProviderCredentialReference,
} from "../native-provider/credential-reference";

export function isNativeCustomCredentialReference(value: string, key: string): boolean {
  return (
    ["COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY"].includes(key) &&
    isNativeProviderCredentialReference(value, key)
  );
}

export async function resolveNativeCustomCredentialReference(
  input: { sandboxName: string; gatewayName: string; credentialEnv: string },
  capture?: Parameters<typeof resolveNativeProviderCredentialReference>[1],
): Promise<string> {
  if (!["COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY"].includes(input.credentialEnv))
    throw new Error("Invalid native custom credential scope.");
  return resolveNativeProviderCredentialReference(input, capture);
}
