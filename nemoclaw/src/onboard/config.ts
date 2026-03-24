// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const CONFIG_DIR = join(process.env.HOME ?? "/tmp", ".nemoclaw");

export type EndpointType = "build" | "ncp" | "nim-local" | "vllm" | "ollama" | "custom";

export interface NemoClawOnboardConfig {
  endpointType: EndpointType;
  endpointUrl: string;
  ncpPartner: string | null;
  model: string;
  profile: string;
  credentialEnv: string;
  provider?: string;
  providerLabel?: string;
  onboardedAt: string;
}

export function describeOnboardEndpoint(config: NemoClawOnboardConfig): string {
  if (config.endpointUrl === "https://inference.local/v1") {
    return "Managed Inference Route (inference.local)";
  }

  return `${config.endpointType} (${config.endpointUrl})`;
}

export function describeOnboardProvider(config: NemoClawOnboardConfig): string {
  if (config.providerLabel) {
    return config.providerLabel;
  }

  switch (config.endpointType) {
    case "build":
      return "NVIDIA Endpoint API";
    case "ollama":
      return "Local Ollama";
    case "vllm":
      return "Local vLLM";
    case "nim-local":
      return "Local NIM";
    case "ncp":
      return "NVIDIA Cloud Partner";
    case "custom":
      return "Managed Inference Route";
    default:
      return "Unknown";
  }
}

let configDirCreated = false;

function ensureConfigDir(): void {
  if (configDirCreated) return;
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  configDirCreated = true;
}

function configPath(): string {
  return join(CONFIG_DIR, "config.json");
}

export function loadOnboardConfig(): NemoClawOnboardConfig | null {
  ensureConfigDir();
  const path = configPath();
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as NemoClawOnboardConfig;
}

export function saveOnboardConfig(config: NemoClawOnboardConfig): void {
  ensureConfigDir();
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

export function clearOnboardConfig(): void {
  const path = configPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
