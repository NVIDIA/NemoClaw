// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Central port configuration — override any port via environment variables.
 * TypeScript counterpart of bin/lib/ports.js.
 */

/**
 * Read an environment variable as a port number, falling back to a default.
 * Validates that the value is a valid non-privileged port (1024-65535).
 */
export function parsePort(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`,
    );
  }
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) {
    throw new Error(
      `Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`,
    );
  }
  return parsed;
}

/** OpenShell gateway port (default 8080, override via NEMOCLAW_GATEWAY_PORT). */
export const GATEWAY_PORT = parsePort("NEMOCLAW_GATEWAY_PORT", 8080);
/** Dashboard UI port (default 18789, override via NEMOCLAW_DASHBOARD_PORT). */
export const DASHBOARD_PORT = parsePort("NEMOCLAW_DASHBOARD_PORT", 18789);
/** vLLM / NIM inference port (default 8000, override via NEMOCLAW_VLLM_PORT). */
export const VLLM_PORT = parsePort("NEMOCLAW_VLLM_PORT", 8000);
/** Ollama inference port (default 11434, override via NEMOCLAW_OLLAMA_PORT). */
export const OLLAMA_PORT = parsePort("NEMOCLAW_OLLAMA_PORT", 11434);
