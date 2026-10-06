// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENROUTER_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { OPENROUTER_ENDPOINT_URL, OPENROUTER_PROVIDER_NAME } from "./managed-dcode/identity";

export { OPENROUTER_ENDPOINT_URL, OPENROUTER_PROVIDER_NAME };
export const OPENROUTER_HELP_URL = "https://openrouter.ai/workspaces/default/keys";
export const OPENROUTER_CREDENTIAL_ENV = "OPENROUTER_API_KEY";
// OpenShell does not expose a native OpenRouter provider profile yet. Register
// OpenRouter through the OpenAI-compatible provider profile while keeping a
// distinct provider name and credential binding in NemoClaw.
export const OPENROUTER_PROVIDER_TYPE = "openai";
export const OPENROUTER_DEFAULT_HEADERS = [
  ["HTTP-Referer", "https://www.nvidia.com/nemoclaw/"],
  ["X-OpenRouter-Title", "NVIDIA NemoClaw"],
] as const;
export const OPENROUTER_RUNTIME_ADAPTER_BIND_HOST = "0.0.0.0";
export const OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_HOST = "127.0.0.1";
export const OPENROUTER_RUNTIME_ADAPTER_SANDBOX_HOST = "host.openshell.internal";
export const OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL = `http://${OPENROUTER_RUNTIME_ADAPTER_SANDBOX_HOST}:${OPENROUTER_RUNTIME_ADAPTER_PORT}/v1`;
export const OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_OPENAI_BASE_URL = `http://${OPENROUTER_RUNTIME_ADAPTER_LOOPBACK_HOST}:${OPENROUTER_RUNTIME_ADAPTER_PORT}/v1`;

/**
 * The `openrouter-api` provider is registered only through NemoClaw's
 * Chat Completions adapter. The adapter does not expose a model catalog, so
 * its models route intentionally returns HTTP 404.
 *
 * Callers must also require a successful bounded inference request. This
 * predicate identifies the adapter contract; it does not establish readiness.
 */
export function isOpenRouterRuntimeAdapterModelsRoute404(
  provider: string | null | undefined,
  httpStatus: number,
): boolean {
  return provider?.trim() === OPENROUTER_PROVIDER_NAME && httpStatus === 404;
}

export function getOpenRouterCurlHeaders(): string[] {
  return OPENROUTER_DEFAULT_HEADERS.map(([name, value]) => `${name}: ${value}`);
}
