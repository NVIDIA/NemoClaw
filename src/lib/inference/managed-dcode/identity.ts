// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENROUTER_ENDPOINT_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_PROVIDER_NAME = "openrouter-api";

export type ManagedDcodeProvider = "openai" | "openrouter";

export type ManagedDcodeIdentity = {
  provider: ManagedDcodeProvider;
  model: string;
  defaultModel: string;
};

export function normalizeManagedDcodeEndpointUrl(
  value: string | null | undefined,
  name: string,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error(`${name} must not contain control characters.`);
  }
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not include query strings or fragments.`);
  }
  return url.href;
}

export function normalizeManagedDcodeModelName(model: string): string {
  const trimmed = model.trim();
  for (const prefix of ["openai:", "openrouter:"]) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

function isOpenRouterEndpointUrl(value: string | null | undefined): boolean {
  try {
    const normalized = normalizeManagedDcodeEndpointUrl(value, "endpoint URL");
    if (!normalized) return false;
    const url = new URL(normalized);
    const openRouterUrl = new URL(OPENROUTER_ENDPOINT_URL);
    return (
      url.origin === openRouterUrl.origin &&
      url.pathname.replace(/\/+$/, "") === openRouterUrl.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

export function resolveManagedDcodeIdentity(
  upstreamProvider: string | null | undefined,
  model: string,
  upstreamEndpointUrl: string | null | undefined,
): ManagedDcodeIdentity {
  const providerName = upstreamProvider?.trim();
  const provider =
    providerName === "openrouter" ||
    providerName === OPENROUTER_PROVIDER_NAME ||
    (providerName === "compatible-endpoint" && isOpenRouterEndpointUrl(upstreamEndpointUrl))
      ? "openrouter"
      : "openai";
  const normalizedModel = normalizeManagedDcodeModelName(model);
  return {
    provider,
    model: normalizedModel,
    defaultModel: `${provider}:${normalizedModel}`,
  };
}
