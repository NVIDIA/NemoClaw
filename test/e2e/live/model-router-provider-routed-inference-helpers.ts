// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

export function buildProviderRoutedEnv(
  apiKey: string,
  sandboxName: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(baseEnv),
    // CI's NVIDIA_API_KEY is the public nvapi-* credential for
    // integrate.api.nvidia.com. The routed blueprint still declares the
    // historical NVIDIA_INFERENCE_API_KEY runtime credential name, so alias
    // the public value only in this child environment. Hosted lanes instead
    // source their sk-* NVIDIA_INFERENCE_API_KEY for inference-api.nvidia.com.
    NVIDIA_INFERENCE_API_KEY: apiKey,
    NEMOCLAW_PROVIDER_KEY: apiKey,
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_POLICY_TIER: "open",
    NEMOCLAW_PROVIDER: "routed",
  };
}
