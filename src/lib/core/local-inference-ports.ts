// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const VLLM_PORT_ENV = "NEMOCLAW_VLLM_PORT";
export const LLAMA_CPP_PORT_ENV = "NEMOCLAW_LLAMACPP_PORT";
export const OLLAMA_PORT_ENV = "NEMOCLAW_OLLAMA_PORT";
export const OLLAMA_PROXY_PORT_ENV = "NEMOCLAW_OLLAMA_PROXY_PORT";

export const DEFAULT_VLLM_PORT = 8000;
export const DEFAULT_LLAMA_CPP_PORT = 8081;
export const DEFAULT_OLLAMA_PORT = 11434;
export const DEFAULT_OLLAMA_PROXY_PORT = 11435;

/** Read one environment variable as a non-privileged TCP port. */
export function parsePort(
  envVar: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = String(raw).trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65_535) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  return parsed;
}

export const VLLM_PORT = parsePort(VLLM_PORT_ENV, DEFAULT_VLLM_PORT);
export const LLAMA_CPP_PORT = parsePort(LLAMA_CPP_PORT_ENV, DEFAULT_LLAMA_CPP_PORT);
export const OLLAMA_PORT = parsePort(OLLAMA_PORT_ENV, DEFAULT_OLLAMA_PORT);
export const OLLAMA_PROXY_PORT = parsePort(OLLAMA_PROXY_PORT_ENV, DEFAULT_OLLAMA_PROXY_PORT);
