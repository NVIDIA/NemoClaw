// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function validateNvidiaApiKeyValue(
  key: string,
  credentialEnv: string = "NVIDIA_INFERENCE_API_KEY",
): string | null {
  // The nvapi- prefix check is specific to NVIDIA keys; skip it for keys
  // from other providers (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) so that
  // a valid Anthropic key is not rejected with an NVIDIA-specific error.
  const isNvidia =
    credentialEnv === "NVIDIA_INFERENCE_API_KEY" || credentialEnv === "NVIDIA_API_KEY";
  if (!key) {
    return isNvidia ? "  NVIDIA API Key is required." : "  API Key is required.";
  }
  if (isNvidia && !key.startsWith("nvapi-")) {
    return "  Invalid NVIDIA API key. Must start with nvapi-";
  }
  return null;
}
