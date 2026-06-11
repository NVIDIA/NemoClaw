// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import type { HermesBuildSettings } from "./build-env.ts";
import { loadManagedToolGatewayMatrix } from "./managed-tool-gateway.ts";

export function buildHermesEnvLines(settings: HermesBuildSettings): string[] {
  const envLines = [
    "API_SERVER_PORT=18642",
    "API_SERVER_HOST=127.0.0.1",
    // Hermes v0.16.0+ guards its OpenAI-compatible api_server with a bearer
    // token read from API_SERVER_KEY; without it the gateway refuses to start.
    // Self-minted, loopback-only token (not an egress credential), so it lives
    // raw in .env and is allowlisted in validate-env-secret-boundary.py.
    `API_SERVER_KEY=${randomBytes(32).toString("hex")}`,
  ];

  if (!settings.managedToolGateways.brokerEnabled) return envLines;

  const matrix = loadManagedToolGatewayMatrix();
  envLines.push("NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1");
  for (const preset of settings.managedToolGateways.presets) {
    const entry = matrix[preset];
    if (!entry) {
      throw new Error(`Unknown Hermes managed-tool gateway preset: ${preset}`);
    }
    envLines.push(`${entry.envKey}=${entry.envValue}`);
  }

  return envLines;
}
