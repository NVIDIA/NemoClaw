// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isNativeProviderCredentialReference,
  resolveNativeProviderCredentialReference,
} from "../native-provider/credential-reference";

export function isNativeNvidiaCredentialReference(value: string): boolean {
  return isNativeProviderCredentialReference(value, "NVIDIA_INFERENCE_API_KEY");
}

/** Read only the selected sandbox's issued handle, never its raw credential. */
export async function resolveNativeNvidiaCredentialReference(
  input: { sandboxName: string; gatewayName: string },
  capture?: Parameters<typeof resolveNativeProviderCredentialReference>[1],
): Promise<string> {
  return resolveNativeProviderCredentialReference(
    { ...input, credentialEnv: "NVIDIA_INFERENCE_API_KEY" },
    capture,
  );
}
