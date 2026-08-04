// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Stable contract for operator-run llama.cpp existing-server attachment. */
export const LLAMA_CPP_SELECTION_KEY = "llama-cpp";
export const LLAMA_CPP_PROVIDER_NAME = "llama-cpp-local";
export const LLAMA_CPP_PROVIDER_LABEL = "Local llama.cpp";
export const LLAMA_CPP_CREDENTIAL_ENV = "NEMOCLAW_LLAMACPP_LOCAL_TOKEN";
export const LLAMA_CPP_PORT = 8081;
export const LLAMA_CPP_HOST_BASE_URL = `http://127.0.0.1:${LLAMA_CPP_PORT}`;
export const LLAMA_CPP_HOST_OPENAI_BASE_URL = `${LLAMA_CPP_HOST_BASE_URL}/v1`;
export const LLAMA_CPP_GATEWAY_BASE_URL = `http://host.openshell.internal:${LLAMA_CPP_PORT}/v1`;

const MAX_LLAMA_CPP_SERVED_MODEL_ALIAS_BYTES = 256;

/** A served alias may contain namespaces, but must not expose a model filesystem path. */
export function isSafeLlamaCppServedModelAlias(value: string): boolean {
  const alias = value.trim();
  if (!alias || alias !== value) return false;
  if (Buffer.byteLength(alias, "utf8") > MAX_LLAMA_CPP_SERVED_MODEL_ALIAS_BYTES) {
    return false;
  }
  if (!/^[A-Za-z0-9._:/-]+$/.test(alias)) return false;
  if (/^(?:file:|[A-Za-z]:[\\/]|[./~]|\\\\)/i.test(alias)) return false;
  if (alias.split("/").some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  if (alias.includes("\\") || /\.gguf$/i.test(alias)) return false;
  return true;
}
