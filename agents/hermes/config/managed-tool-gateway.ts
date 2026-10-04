// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HermesBuildSettings } from "./build-env.ts";

export type ManagedToolGatewayEntry = {
  service: string;
  config: Record<string, unknown>;
  envKey: string;
  envValue: string;
};

export type ManagedToolGatewayMatrix = Record<string, ManagedToolGatewayEntry>;

export function effectiveManagedToolGatewayPresets(
  settings: Pick<HermesBuildSettings, "managedToolGateways" | "webSearchProvider">,
): string[] {
  if (!settings.managedToolGateways.brokerEnabled) return [];

  return settings.managedToolGateways.presets.filter(
    (preset) => !(settings.webSearchProvider === "tavily" && preset === "nous-web"),
  );
}

export function loadManagedToolGatewayMatrix(
  env: NodeJS.ProcessEnv = process.env,
): ManagedToolGatewayMatrix {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.NEMOCLAW_HERMES_TOOL_GATEWAY_MATRIX_PATH,
    join(scriptDir, "hermes-managed-tool-gateway-matrix.json"),
    join(scriptDir, "../hermes-managed-tool-gateway-matrix.json"),
    join(scriptDir, "../host/managed-tool-gateway-matrix.json"),
    "/opt/nemoclaw-hermes-config/managed-tool-gateway-matrix.json",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return JSON.parse(readFileSync(candidate, "utf8")) as ManagedToolGatewayMatrix;
  }

  throw new Error("Hermes managed tool gateway matrix not found");
}

export function applyManagedToolConfig(
  config: Record<string, unknown>,
  entryConfig: Record<string, unknown>,
): void {
  for (const [section, sectionValue] of Object.entries(entryConfig)) {
    if (
      sectionValue &&
      typeof sectionValue === "object" &&
      !Array.isArray(sectionValue) &&
      config[section] &&
      typeof config[section] === "object" &&
      !Array.isArray(config[section])
    ) {
      config[section] = {
        ...(config[section] as Record<string, unknown>),
        ...(sectionValue as Record<string, unknown>),
      };
    } else {
      config[section] = sectionValue;
    }
  }
}
