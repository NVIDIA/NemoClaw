// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const PUBLIC_NVIDIA_PROVIDERS = new Set(["build", "cloud", "nvidia", "nvidia-prod"]);

/** Detects hosted-compatible inference that is managed by the gateway. */
export function isGatewayManagedCompatibleInference(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE === "1") return true;
  if (PUBLIC_NVIDIA_PROVIDERS.has(env.NEMOCLAW_PROVIDER ?? "")) return false;

  const key = env.NVIDIA_INFERENCE_API_KEY ?? "";
  return key.length > 0 && !key.startsWith("nvapi-");
}
