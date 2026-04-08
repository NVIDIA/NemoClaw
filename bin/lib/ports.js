// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Central port configuration — override any port via environment variables.
// Based on the approach from jnun (PR #683).

/**
 * Read an environment variable as a port number, falling back to a default.
 * Validates that the value is a valid non-privileged port (1024–65535).
 *
 * @param {string} envVar  - Name of the environment variable.
 * @param {number} fallback - Default port when the variable is unset.
 * @returns {number}
 */
function parsePort(envVar, fallback) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  return parsed;
}

/** OpenShell gateway port (default 8080, override via NEMOCLAW_GATEWAY_PORT). */
const GATEWAY_PORT = parsePort("NEMOCLAW_GATEWAY_PORT", 8080);
/** Dashboard UI port (default 18789, override via NEMOCLAW_DASHBOARD_PORT). */
const DASHBOARD_PORT = parsePort("NEMOCLAW_DASHBOARD_PORT", 18789);
/** vLLM / NIM inference port (default 8000, override via NEMOCLAW_VLLM_PORT). */
const VLLM_PORT = parsePort("NEMOCLAW_VLLM_PORT", 8000);
/** Ollama inference port (default 11434, override via NEMOCLAW_OLLAMA_PORT). */
const OLLAMA_PORT = parsePort("NEMOCLAW_OLLAMA_PORT", 11434);

module.exports = { GATEWAY_PORT, DASHBOARD_PORT, VLLM_PORT, OLLAMA_PORT, parsePort };
