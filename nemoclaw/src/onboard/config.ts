// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let configDir = join(homedir(), ".nemoclaw");

export type EndpointType =
  | "build"
  | "openai"
  | "anthropic"
  | "gemini"
  | "ncp"
  | "nim-local"
  | "vllm"
  | "ollama"
  | "custom";

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

type OnboardConfigSource = {
  endpointType?: string | null;
  endpointUrl?: string;
  ncpPartner?: string | null;
  model?: string;
  profile?: string;
  credentialEnv?: string;
  provider?: string;
  providerLabel?: string;
  onboardedAt?: string;
};

function isRecord(value: object | null): value is OnboardConfigSource {
  return value !== null && !Array.isArray(value);
}

function isEndpointType(value: string | null | undefined): value is EndpointType {
  return (
    value === "build" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "gemini" ||
    value === "ncp" ||
    value === "nim-local" ||
    value === "vllm" ||
    value === "ollama" ||
    value === "custom"
  );
}

function isOptionalString(value: string | null | undefined): boolean {
  return value === undefined || typeof value === "string";
}

function isOnboardConfig(value: OnboardConfigSource | null): value is NemoClawOnboardConfig {
  return (
    isRecord(value) &&
    isEndpointType(value.endpointType) &&
    typeof value.endpointUrl === "string" &&
    (value.ncpPartner === null || typeof value.ncpPartner === "string") &&
    typeof value.model === "string" &&
    typeof value.profile === "string" &&
    typeof value.credentialEnv === "string" &&
    isOptionalString(value.providerLabel) &&
    isOptionalString(value.provider) &&
    typeof value.onboardedAt === "string"
  );
}

export function describeOnboardEndpoint(config: NemoClawOnboardConfig): string {
  if (config.endpointUrl === "https://inference.local/v1") {
    return "Managed Inference Route (inference.local)";
  }

  let safeUrl = config.endpointUrl;
  try {
    const parsed = new URL(config.endpointUrl);
    if (parsed.password) parsed.password = "****";
    if (parsed.username) parsed.username = "****";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(token|key|secret|auth|sig|credential|password)/i.test(key)) {
        parsed.searchParams.set(key, "****");
      }
    }
    safeUrl = parsed.toString();
  } catch {
    // Not a valid URL — show as-is
  }
  return `${config.endpointType} (${safeUrl})`;
}

export function describeOnboardProvider(config: NemoClawOnboardConfig): string {
  if (config.providerLabel) {
    return config.providerLabel;
  }

  switch (config.endpointType) {
    case "build":
      return "NVIDIA Endpoints";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    case "ollama":
      return "Local Ollama";
    case "vllm":
      return "Local vLLM";
    case "nim-local":
      return "Local NVIDIA NIM";
    case "ncp":
      return "NVIDIA Cloud Partner";
    case "custom":
      return "Other OpenAI-compatible endpoint";
    default:
      return "Unknown";
  }
}

let configDirCreated = false;

function ensureConfigDir(): void {
  if (configDirCreated) return;
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
    } catch {
      configDir = join(tmpdir(), ".nemoclaw");
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
    }
  }
  configDirCreated = true;
}

function configPath(): string {
  return join(configDir, "config.json");
}

export function loadOnboardConfig(): NemoClawOnboardConfig | null {
  ensureConfigDir();
  const path = configPath();
  if (!existsSync(path)) {
    return null;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const parsedObject = typeof parsed === "object" && parsed !== null ? parsed : null;
  return isOnboardConfig(parsedObject) ? parsedObject : null;
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
