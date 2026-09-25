// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { LLAMA_CPP_PORT } from "../inference/llama-cpp/contract";
import { DEFAULT_OLLAMA_PROXY_PORT, OLLAMA_PROXY_PORT } from "./ollama-proxy-port";
import {
  BEDROCK_RUNTIME_ADAPTER_PORT,
  DASHBOARD_PORT,
  DASHBOARD_PORT_RANGE_END,
  DASHBOARD_PORT_RANGE_START,
  DEFAULT_BEDROCK_RUNTIME_ADAPTER_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT,
  HERMES_API_PORT_RANGE_END,
  HERMES_API_PORT_RANGE_START,
  HERMES_OPENAI_API_PORT,
  HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  isHermesApiPort,
  OPENROUTER_RUNTIME_ADAPTER_PORT,
  SANDBOX_DASHBOARD_PORT,
} from "./protected-host-ports";
import { parseServicePortOverride } from "./service-port-boundary";

export {
  BEDROCK_RUNTIME_ADAPTER_PORT,
  DASHBOARD_PORT,
  DASHBOARD_PORT_RANGE_END,
  DASHBOARD_PORT_RANGE_START,
  DEFAULT_BEDROCK_RUNTIME_ADAPTER_PORT,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT,
  HERMES_API_PORT_RANGE_END,
  HERMES_API_PORT_RANGE_START,
  HERMES_OPENAI_API_PORT,
  HTTPS_PIN_RUNTIME_ADAPTER_PORT,
  isHermesApiPort,
  OPENROUTER_RUNTIME_ADAPTER_PORT,
};

/**
 * Central port configuration — override any port via environment variables.
 * TypeScript counterpart of bin/lib/ports.js.
 */

/**
 * Read an environment variable as a port number, falling back to a default.
 * Validates that the value is a valid non-privileged port (1024-65535).
 */
export function parsePort(
  envVar: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseServicePortOverride(envVar, env[envVar], fallback);
}

export interface GatewayPortValidationOptions {
  dashboardPort: number;
  dashboardRangeStart: number;
  dashboardRangeEnd: number;
  vllmPort: number;
  ollamaPort: number;
  ollamaProxyPort: number;
  bedrockRuntimeAdapterPort: number;
  openrouterRuntimeAdapterPort: number;
  httpsPinRuntimeAdapterPort: number;
}

export interface RuntimeAdapterPortValidationOptions extends GatewayPortValidationOptions {
  gatewayPort: number;
}

type PortValidationOptions = GatewayPortValidationOptions | RuntimeAdapterPortValidationOptions;

export const VLLM_PORT_ENV = "NEMOCLAW_VLLM_PORT";
export const DEFAULT_VLLM_PORT = 8000;
/** vLLM / NIM inference port (default 8000, override via NEMOCLAW_VLLM_PORT). */
export const VLLM_PORT = parsePort(VLLM_PORT_ENV, DEFAULT_VLLM_PORT);
/** Ollama inference port (default 11434, override via NEMOCLAW_OLLAMA_PORT). */
export const OLLAMA_PORT = parsePort("NEMOCLAW_OLLAMA_PORT", 11434);
/** Ollama auth proxy port (default 11435, override via NEMOCLAW_OLLAMA_PROXY_PORT). */
export { DEFAULT_OLLAMA_PROXY_PORT, OLLAMA_PROXY_PORT };
/** llama.cpp existing-server attachment port; fixed by the declarative serving contract. */
export { LLAMA_CPP_PORT };
interface ServicePortDefinition {
  readonly envVar: string | null;
  readonly label: string;
  readonly defaultPort: number;
  readonly reserveDefault: boolean;
  readonly configuredPort: (options: PortValidationOptions) => number | undefined;
}

/**
 * Services that participate in host-port collision validation. The gateway
 * default is reusable after the gateway is reconfigured, while the dashboard
 * allocation range and inference and adapter defaults remain reserved.
 */
const SERVICE_PORT_CATALOG: readonly ServicePortDefinition[] = [
  {
    envVar: "NEMOCLAW_GATEWAY_PORT",
    label: "OpenShell gateway",
    defaultPort: DEFAULT_GATEWAY_PORT,
    reserveDefault: false,
    configuredPort: (options) => ("gatewayPort" in options ? options.gatewayPort : undefined),
  },
  {
    envVar: "NEMOCLAW_DASHBOARD_PORT",
    label: "dashboard",
    defaultPort: SANDBOX_DASHBOARD_PORT,
    reserveDefault: false,
    configuredPort: (options) => options.dashboardPort,
  },
  {
    envVar: "NEMOCLAW_VLLM_PORT",
    label: "vLLM / NIM inference",
    defaultPort: 8000,
    reserveDefault: true,
    configuredPort: (options) => options.vllmPort,
  },
  {
    envVar: null,
    label: "llama.cpp inference",
    defaultPort: LLAMA_CPP_PORT,
    reserveDefault: true,
    configuredPort: () => undefined,
  },
  {
    envVar: "NEMOCLAW_OLLAMA_PORT",
    label: "Ollama inference",
    defaultPort: 11434,
    reserveDefault: true,
    configuredPort: (options) => options.ollamaPort,
  },
  {
    envVar: "NEMOCLAW_OLLAMA_PROXY_PORT",
    label: "Ollama auth proxy",
    defaultPort: 11435,
    reserveDefault: true,
    configuredPort: (options) => options.ollamaProxyPort,
  },
  {
    envVar: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT",
    label: "Bedrock Runtime adapter",
    defaultPort: DEFAULT_BEDROCK_RUNTIME_ADAPTER_PORT,
    reserveDefault: true,
    configuredPort: (options) => options.bedrockRuntimeAdapterPort,
  },
  {
    envVar: "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
    label: "OpenRouter Runtime adapter",
    defaultPort: DEFAULT_OPENROUTER_RUNTIME_ADAPTER_PORT,
    reserveDefault: true,
    configuredPort: (options) => options.openrouterRuntimeAdapterPort,
  },
  {
    envVar: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
    label: "HTTPS Pin Runtime adapter",
    defaultPort: DEFAULT_HTTPS_PIN_RUNTIME_ADAPTER_PORT,
    reserveDefault: true,
    configuredPort: (options) => options.httpsPinRuntimeAdapterPort,
  },
];

function validateServicePort(
  envVar: string,
  port: number,
  options: PortValidationOptions,
  serviceEnvVar: string,
): void {
  if (port >= options.dashboardRangeStart && port <= options.dashboardRangeEnd) {
    throw new Error(
      `Invalid port: ${envVar}="${port}" — must not overlap the ${options.dashboardRangeStart}-${options.dashboardRangeEnd} dashboard port range`,
    );
  }

  const reservedDefault = SERVICE_PORT_CATALOG.find(
    (entry) => entry.reserveDefault && entry.envVar !== serviceEnvVar && entry.defaultPort === port,
  );
  if (reservedDefault) {
    throw new Error(
      `Invalid port: ${envVar}="${port}" — must not overlap the ${reservedDefault.label} default port (${reservedDefault.defaultPort})`,
    );
  }

  const conflict = SERVICE_PORT_CATALOG.find(
    (entry) =>
      entry.envVar !== null &&
      entry.envVar !== serviceEnvVar &&
      entry.configuredPort(options) === port,
  );
  if (conflict) {
    throw new Error(
      `Invalid port: ${envVar}="${port}" — conflicts with ${conflict.envVar} (${port})`,
    );
  }
}

export function validateGatewayPort(
  envVar: string,
  port: number,
  options: GatewayPortValidationOptions,
): void {
  validateServicePort(envVar, port, options, "NEMOCLAW_GATEWAY_PORT");
}

export function parseGatewayPort(
  envVar: string,
  fallback: number,
  options: GatewayPortValidationOptions,
): number {
  const port = parsePort(envVar, fallback);
  validateGatewayPort(envVar, port, options);
  return port;
}

/** OpenShell gateway port (default 8080, override via NEMOCLAW_GATEWAY_PORT). */
export const GATEWAY_PORT = parseGatewayPort("NEMOCLAW_GATEWAY_PORT", DEFAULT_GATEWAY_PORT, {
  dashboardPort: DASHBOARD_PORT,
  dashboardRangeStart: DASHBOARD_PORT_RANGE_START,
  dashboardRangeEnd: DASHBOARD_PORT_RANGE_END,
  vllmPort: VLLM_PORT,
  ollamaPort: OLLAMA_PORT,
  ollamaProxyPort: OLLAMA_PROXY_PORT,
  bedrockRuntimeAdapterPort: BEDROCK_RUNTIME_ADAPTER_PORT,
  openrouterRuntimeAdapterPort: OPENROUTER_RUNTIME_ADAPTER_PORT,
  httpsPinRuntimeAdapterPort: HTTPS_PIN_RUNTIME_ADAPTER_PORT,
});

/** The live host-port configuration every runtime adapter is validated against. */
const CURRENT_RUNTIME_PORT_CONFIGURATION: RuntimeAdapterPortValidationOptions = {
  gatewayPort: GATEWAY_PORT,
  dashboardPort: DASHBOARD_PORT,
  dashboardRangeStart: DASHBOARD_PORT_RANGE_START,
  dashboardRangeEnd: DASHBOARD_PORT_RANGE_END,
  vllmPort: VLLM_PORT,
  ollamaPort: OLLAMA_PORT,
  ollamaProxyPort: OLLAMA_PROXY_PORT,
  bedrockRuntimeAdapterPort: BEDROCK_RUNTIME_ADAPTER_PORT,
  openrouterRuntimeAdapterPort: OPENROUTER_RUNTIME_ADAPTER_PORT,
  httpsPinRuntimeAdapterPort: HTTPS_PIN_RUNTIME_ADAPTER_PORT,
};

/**
 * Reject a runtime adapter port that overlaps the dashboard allocation range, a
 * reserved service default, or another configured service port. `ownerEnvVar`
 * names the adapter being validated: it is both the variable reported in the
 * error and the catalog entry excluded from the self-conflict check. Tests
 * inject `options`; production callers use the live configuration above.
 */
export function validateRuntimeAdapterPort(
  ownerEnvVar: string,
  port: number,
  options: RuntimeAdapterPortValidationOptions = CURRENT_RUNTIME_PORT_CONFIGURATION,
): void {
  validateServicePort(ownerEnvVar, port, options, ownerEnvVar);
}

/** Reject every configurable service collision with fixed llama.cpp attachment port 8081. */
export function validateLlamaCppPortReservation(
  options: RuntimeAdapterPortValidationOptions,
): void {
  const conflict = SERVICE_PORT_CATALOG.find(
    (entry) => entry.envVar !== null && entry.configuredPort(options) === LLAMA_CPP_PORT,
  );
  if (conflict) {
    throw new Error(
      `Invalid port: ${conflict.envVar}="${LLAMA_CPP_PORT}" — conflicts with the fixed llama.cpp inference port (${LLAMA_CPP_PORT})`,
    );
  }
}

validateLlamaCppPortReservation(CURRENT_RUNTIME_PORT_CONFIGURATION);
