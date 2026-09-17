// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

const PORT_ENV_NAME =
  "NEMOCLAW_(?:GATEWAY|DASHBOARD|VLLM|OLLAMA|OLLAMA_PROXY|BEDROCK_RUNTIME_ADAPTER|OPENROUTER_RUNTIME_ADAPTER|HTTPS_PIN_RUNTIME_ADAPTER)_PORT";
export const SAFE_PORT_DIAGNOSTIC = new RegExp(
  `^Invalid port: ${PORT_ENV_NAME}="\\d{1,5}" — (?:must be an integer between 1024 and 65535|must not overlap the 18789-18799 dashboard port range|must not overlap the (?:llama\\.cpp inference|vLLM / NIM inference|Ollama inference|Ollama auth proxy|Bedrock Runtime adapter|OpenRouter Runtime adapter|HTTPS Pin Runtime adapter) default port \\(\\d{1,5}\\)|conflicts with ${PORT_ENV_NAME} \\(\\d{1,5}\\)|conflicts with the fixed llama\\.cpp inference port \\(8081\\))$`,
);
export const SAFE_AUTOMATIC_GATEWAY_PORT_DIAGNOSTIC =
  "Could not safely resolve the automatically selected NemoClaw gateway port. " +
  "Remove invalid automatic-gateway-port markers or set NEMOCLAW_GATEWAY_PORT explicitly.";

export function applyPersistedAutomaticGatewayPort(): void {
  if (process.env.NEMOCLAW_GATEWAY_PORT) {
    const installerAutomaticPort =
      process.env.NEMOCLAW_INSTALLING === "1" &&
      process.env._NEMOCLAW_AUTOMATIC_GATEWAY_PORT === "1";
    if (!installerAutomaticPort) delete process.env._NEMOCLAW_AUTOMATIC_GATEWAY_PORT;
    return;
  }
  const resolver = path.join(__dirname, "..", "..", "..", "..", "..", "scripts", "install.sh");
  const configuredPortNames = [
    "NEMOCLAW_DASHBOARD_PORT",
    "NEMOCLAW_HERMES_DASHBOARD_PORT",
    "NEMOCLAW_VLLM_PORT",
    "NEMOCLAW_OLLAMA_PORT",
    "NEMOCLAW_OLLAMA_PROXY_PORT",
    "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_PORT",
    "NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT",
    "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_PORT",
  ];
  const configuredPorts = Object.fromEntries(
    configuredPortNames.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
  const result = spawnSync("/bin/bash", [resolver, "--internal-resolve-automatic-gateway-port"], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME || "/",
      PATH: "/usr/bin:/bin",
      NEMOCLAW_GATEWAY_PORT: "",
      ...configuredPorts,
    },
    maxBuffer: 64 * 1024,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(SAFE_AUTOMATIC_GATEWAY_PORT_DIAGNOSTIC);
  }
  const port = result.stdout;
  if (port === "8080") return;
  if (/^(?:899[0-9]|900[0-5])$/.test(port)) {
    process.env.NEMOCLAW_GATEWAY_PORT = port;
    process.env._NEMOCLAW_AUTOMATIC_GATEWAY_PORT = "1";
    return;
  }
  throw new Error(SAFE_AUTOMATIC_GATEWAY_PORT_DIAGNOSTIC);
}
