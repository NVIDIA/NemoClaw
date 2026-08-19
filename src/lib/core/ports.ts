// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { LLAMA_CPP_PORT } from "../inference/llama-cpp/contract";

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
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) {
    throw new Error(`Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`);
  }
  return parsed;
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

/** Default OpenShell gateway port when NEMOCLAW_GATEWAY_PORT is unset. */
export const DEFAULT_GATEWAY_PORT = 8080;

/**
 * The default port the OpenClaw dashboard listens on inside the sandbox.
 * The sandbox image is built with CHAT_UI_URL=http://127.0.0.1:SANDBOX_DASHBOARD_PORT
 * (patched by patchStagedDockerfile), so the gateway starts on whichever port was
 * configured via NEMOCLAW_DASHBOARD_PORT at onboard time. This constant represents
 * the hardcoded default when no override is set.
 */
const SANDBOX_DASHBOARD_PORT = 18789;
/** Dashboard UI port (default SANDBOX_DASHBOARD_PORT, override via NEMOCLAW_DASHBOARD_PORT). This is the host-side port. */
export const DASHBOARD_PORT = parsePort("NEMOCLAW_DASHBOARD_PORT", SANDBOX_DASHBOARD_PORT);
/** Start of the auto-allocation range for dashboard ports (inclusive). */
export const DASHBOARD_PORT_RANGE_START = SANDBOX_DASHBOARD_PORT;
/** End of the auto-allocation range for dashboard ports (inclusive). */
export const DASHBOARD_PORT_RANGE_END = 18799;
/** vLLM / NIM inference port (default 8000, override via NEMOCLAW_VLLM_PORT). */
export const VLLM_PORT = parsePort("NEMOCLAW_VLLM_PORT", 8000);
/** Ollama inference port (default 11434, override via NEMOCLAW_OLLAMA_PORT). */
export const OLLAMA_PORT = parsePort("NEMOCLAW_OLLAMA_PORT", 11434);
/** Ollama auth proxy port (default 11435, override via NEMOCLAW_OLLAMA_PROXY_PORT). */
export const OLLAMA_PROXY_PORT = parsePort("NEMOCLAW_OLLAMA_PROXY_PORT", 11435);
/** llama.cpp existing-server attachment port; fixed by the declarative serving contract. */
export { LLAMA_CPP_PORT };
/** Default Hermes OpenAI-compatible API port (manifest `forward_ports[1]`; the default for start.sh `PUBLIC_PORT`). */
export const HERMES_OPENAI_API_PORT = 8642;
/** Start of the auto-allocation range for Hermes API ports (inclusive). */
export const HERMES_API_PORT_RANGE_START = HERMES_OPENAI_API_PORT;
/** End of the auto-allocation range for Hermes API ports (inclusive). */
export const HERMES_API_PORT_RANGE_END = 8652;

/**
 * The API port is a per-sandbox host resource: each Hermes sandbox exposes its
 * OpenAI-compatible API on its own port allocated from
 * `HERMES_API_PORT_RANGE_START` through `HERMES_API_PORT_RANGE_END`, so two
 * sandboxes can serve inference on one host. Every port in that range is
 * therefore unavailable as a dashboard port, for any agent.
 */
export function isHermesApiPort(port: number): boolean {
  return port >= HERMES_API_PORT_RANGE_START && port <= HERMES_API_PORT_RANGE_END;
}
/** Bedrock Runtime adapter port (default 11436, override via NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT). */
export const BEDROCK_RUNTIME_ADAPTER_PORT = parsePort(
  "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT",
  11436,
);
/** OpenRouter header-injection adapter port (default 11437, override via NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT). */
export const OPENROUTER_RUNTIME_ADAPTER_PORT = parsePort(
  "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
  11437,
);
/** HTTPS DNS-pinning reverse-proxy adapter port (default 11438, override via NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT). */
export const HTTPS_PIN_RUNTIME_ADAPTER_PORT = parsePort(
  "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
  11438,
);

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
    defaultPort: 11436,
    reserveDefault: true,
    configuredPort: (options) => options.bedrockRuntimeAdapterPort,
  },
  {
    envVar: "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
    label: "OpenRouter Runtime adapter",
    defaultPort: 11437,
    reserveDefault: true,
    configuredPort: (options) => options.openrouterRuntimeAdapterPort,
  },
  {
    envVar: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
    label: "HTTPS Pin Runtime adapter",
    defaultPort: 11438,
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
