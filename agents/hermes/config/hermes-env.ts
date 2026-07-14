// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesBuildSettings } from "./build-env.ts";
import {
  effectiveManagedToolGatewayPresets,
  loadManagedToolGatewayMatrix,
} from "./managed-tool-gateway.ts";

const TAVILY_API_KEY_PLACEHOLDER = "openshell:resolve:env:TAVILY_API_KEY";

export function buildHermesEnvLines(
  settings: HermesBuildSettings,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const envLines = ["API_SERVER_PORT=18642", "API_SERVER_HOST=127.0.0.1"];

  for (const { envKey, placeholder } of settings.messagingCredentialPlaceholders) {
    envLines.push(`${envKey}=${placeholder}`);
  }

  if (settings.webSearchProvider === "tavily") {
    envLines.push(`TAVILY_API_KEY=${TAVILY_API_KEY_PLACEHOLDER}`);
  }

  const managedToolGatewayPresets = effectiveManagedToolGatewayPresets(settings);
  if (managedToolGatewayPresets.length === 0) return envLines;

  const matrix = loadManagedToolGatewayMatrix(env);
  envLines.push("NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=1");
  for (const preset of managedToolGatewayPresets) {
    const entry = matrix[preset];
    if (!entry) {
      throw new Error(`Unknown Hermes managed-tool gateway preset: ${preset}`);
    }
    envLines.push(`${entry.envKey}=${entry.envValue}`);
  }

  return envLines;
}
