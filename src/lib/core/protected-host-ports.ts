// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_OLLAMA_PROXY_PORT, OLLAMA_PROXY_PORT } from "./ollama-proxy-port";
import { DEFAULT_MODEL_ROUTER_PORT, resolveConfiguredModelRouterPort } from "./model-router-port";
import { parseServicePortOverride } from "./service-port-boundary";

export { DEFAULT_MODEL_ROUTER_PORT };

export const DEFAULT_GATEWAY_PORT = 8080;
/** Keep aligned with find_safe_alternate_gateway_port() in scripts/install.sh. */
export const AUTOMATIC_GATEWAY_PORT_RANGE_START = 8990;
export const AUTOMATIC_GATEWAY_PORT_RANGE_END = 9005;
const CONFIGURED_GATEWAY_PORT = parseServicePortOverride(
  "NEMOCLAW_GATEWAY_PORT",
  process.env.NEMOCLAW_GATEWAY_PORT,
  DEFAULT_GATEWAY_PORT,
);
const CONFIGURED_MODEL_ROUTER_PORT = resolveConfiguredModelRouterPort();

/** Default OpenClaw dashboard port inside the sandbox and on the host. */
export const SANDBOX_DASHBOARD_PORT = 18789;
export const DASHBOARD_PORT = parseServicePortOverride(
  "NEMOCLAW_DASHBOARD_PORT",
  process.env.NEMOCLAW_DASHBOARD_PORT,
  SANDBOX_DASHBOARD_PORT,
);
export const DASHBOARD_PORT_RANGE_START = SANDBOX_DASHBOARD_PORT;
export const DASHBOARD_PORT_RANGE_END = 18799;

/** Default Hermes OpenAI-compatible API port and its per-sandbox allocation range. */
export const HERMES_OPENAI_API_PORT = 8642;
export const HERMES_API_PORT_RANGE_START = HERMES_OPENAI_API_PORT;
export const HERMES_API_PORT_RANGE_END = 8652;

export function isHermesApiPort(port: number): boolean {
  return port >= HERMES_API_PORT_RANGE_START && port <= HERMES_API_PORT_RANGE_END;
}

export const DEFAULT_BEDROCK_RUNTIME_ADAPTER_PORT = 11436;
export const BEDROCK_RUNTIME_ADAPTER_PORT = parseServicePortOverride(
  "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT",
  process.env.NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT,
  DEFAULT_BEDROCK_RUNTIME_ADAPTER_PORT,
);
export const DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT = 11437;
export const OPENROUTER_RUNTIME_ADAPTER_PORT = parseServicePortOverride(
  "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
  process.env.NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT,
  DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT,
);
export const DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT = 11438;
export const HTTPS_PIN_RUNTIME_ADAPTER_PORT = parseServicePortOverride(
  "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
  process.env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT,
);

/**
 * Ports that an operator-entered loopback inference URL must never target.
 *
 * Inference backends are intentionally absent: they are valid compatible
 * endpoint targets. This boundary covers NemoClaw's own control plane,
 * credential-injecting adapters, and defaults that stay reserved when an
 * adapter or proxy is moved with an environment override.
 */
export function isProtectedNemoClawHostPort(port: number): boolean {
  return (
    port === DEFAULT_GATEWAY_PORT ||
    port === CONFIGURED_GATEWAY_PORT ||
    (port >= AUTOMATIC_GATEWAY_PORT_RANGE_START && port <= AUTOMATIC_GATEWAY_PORT_RANGE_END) ||
    port === DASHBOARD_PORT ||
    (port >= DASHBOARD_PORT_RANGE_START && port <= DASHBOARD_PORT_RANGE_END) ||
    isHermesApiPort(port) ||
    port === DEFAULT_MODEL_ROUTER_PORT ||
    port === CONFIGURED_MODEL_ROUTER_PORT ||
    port === OLLAMA_PROXY_PORT ||
    port === DEFAULT_OLLAMA_PROXY_PORT ||
    port === BEDROCK_RUNTIME_ADAPTER_PORT ||
    port === DEFAULT_BEDROCK_RUNTIME_ADAPTER_PORT ||
    port === OPENROUTER_RUNTIME_ADAPTER_PORT ||
    port === DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT ||
    port === HTTPS_PIN_RUNTIME_ADAPTER_PORT ||
    port === DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT
  );
}
