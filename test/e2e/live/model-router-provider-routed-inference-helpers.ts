// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

export const MODEL_ROUTER_PUBLIC_KEY_ENV = "NVIDIA_API_KEY";

export interface ModelRouterSecrets {
  required(name: string): string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: unknown };
    text?: unknown;
  }>;
}

export function requireModelRouterPublicKey(secrets: ModelRouterSecrets): string {
  const apiKey = secrets.required(MODEL_ROUTER_PUBLIC_KEY_ENV);
  if (!apiKey.startsWith("nvapi-")) {
    throw new Error("NVIDIA_API_KEY must be a public NVIDIA Endpoints nvapi-* key");
  }
  return apiKey;
}

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

export function routedCompletionReason(raw: string): "ok" | string {
  let response: ChatCompletionResponse;
  try {
    response = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    return "response was not JSON";
  }

  const content = (response.choices ?? [])
    .map((choice) => {
      if (typeof choice.message?.content === "string") return choice.message.content;
      if (typeof choice.text === "string") return choice.text;
      return "";
    })
    .join("\n")
    .trim();
  return content ? "ok" : "response had no completion content";
}
