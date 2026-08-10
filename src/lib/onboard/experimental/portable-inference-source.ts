// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_MODEL_ID_LENGTH = 512;
const MIN_API_KEY_LENGTH = 16;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const OPENAI_ENDPOINT_SUFFIXES = ["/responses", "/chat/completions", "/completions", "/models"];

export interface PortableInferenceSource {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class PortableInferenceSourceError extends Error {
  override readonly name = "PortableInferenceSourceError";
}

function canonicalHostedEndpoint(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > MAX_ENDPOINT_LENGTH) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    let pathname = parsed.pathname.replace(/\/+$/, "");
    for (const suffix of OPENAI_ENDPOINT_SUFFIXES) {
      if (pathname === suffix || pathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length).replace(/\/+$/, "");
        break;
      }
    }
    parsed.pathname = pathname || "/";
    return parsed.pathname === "/" ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function resolvePortableInferenceSource(
  env: NodeJS.ProcessEnv,
): PortableInferenceSource | null {
  const apiKey = env.COMPATIBLE_API_KEY?.trim() ?? "";
  const rawBaseUrl = env.NEMOCLAW_ENDPOINT_URL?.trim() ?? "";
  const model = env.NEMOCLAW_MODEL?.trim() ?? "";
  if (!apiKey && !rawBaseUrl && !model) return null;

  if (
    apiKey.length < MIN_API_KEY_LENGTH ||
    apiKey.length > 8192 ||
    !/^[\u0021-\u007e]+$/.test(apiKey)
  ) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference requires a valid compatible-endpoint API key.",
    );
  }

  const baseUrl = canonicalHostedEndpoint(rawBaseUrl);
  if (!baseUrl) {
    throw new PortableInferenceSourceError(
      "Portable hosted inference requires a credential-free HTTPS endpoint URL.",
    );
  }

  if (!model || model.length > MAX_MODEL_ID_LENGTH || !SAFE_MODEL_ID_PATTERN.test(model)) {
    throw new PortableInferenceSourceError("Portable hosted inference requires a valid model ID.");
  }

  return { apiKey, baseUrl, model };
}
