// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";
import { loadManagedToolGatewayMatrix } from "./managed-tool-gateway.ts";

export function buildHermesEnvLines(settings: HermesBuildSettings): string[] {
  const envLines = ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1"];

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
