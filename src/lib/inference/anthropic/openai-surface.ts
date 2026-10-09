// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Return the OpenAI-compatible base used when a custom Anthropic endpoint is
 * routed through the managed Chat Completions frontend. Anthropic endpoint
 * normalization intentionally strips a trailing `/v1`; OpenShell's OpenAI
 * provider appends `/chat/completions`, so restore `/v1` exactly once here.
 */
export function getCompatibleAnthropicOpenAiSurfaceBaseUrl(
  endpointUrl: string | null | undefined,
): string {
  const trimmed = String(endpointUrl ?? "").replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}
