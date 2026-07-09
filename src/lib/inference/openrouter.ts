// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENROUTER_ENDPOINT_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models-openrouter.json";
export const OPENROUTER_HELP_URL = "https://openrouter.ai/workspaces/default/keys";
export const OPENROUTER_CREDENTIAL_ENV = "OPENROUTER_API_KEY";
export const OPENROUTER_PROVIDER_NAME = "openrouter-api";
// OpenShell does not expose a native OpenRouter provider profile yet. Register
// OpenRouter through the OpenAI-compatible provider profile while keeping a
// distinct provider name and credential binding in NemoClaw.
export const OPENROUTER_PROVIDER_TYPE = "openai";
export const OPENROUTER_DEFAULT_HEADERS = [
  ["HTTP-Referer", "https://www.nvidia.com/nemoclaw/"],
  ["X-OpenRouter-Title", "NVIDIA NemoClaw"],
] as const;

export function getOpenRouterCurlHeaders(): string[] {
  return OPENROUTER_DEFAULT_HEADERS.map(([name, value]) => `${name}: ${value}`);
}
