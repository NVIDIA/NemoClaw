// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDashboardUi } from "./dashboard-ui";
import type { AgentRuntime } from "./runtime-manifest";
import type { AgentSkillIntegration } from "./skill-integration";
import type { AgentWebAuth } from "./web-auth";

export type ManifestScalar = string | number | boolean | null | Date;
export type ManifestValue = ManifestScalar | ManifestRecord | ManifestValue[];
export type ManifestRecord = { [key: string]: ManifestValue };
export type StringMap = { [key: string]: string };

export interface AgentHealthProbe {
  url: string;
  port: number;
  timeout_seconds: number;
}

export interface AgentConfigPaths {
  dir: string;
  configFile: string;
  envFile: string | null;
  format: string;
}

export type AgentDashboardKind = "ui" | "api";

export interface AgentDashboard {
  kind: AgentDashboardKind;
  label: string;
  path: string;
  healthPath: string;
  auth: "url_token" | "session" | "none";
}

export interface AgentInference {
  provider_type?: string;
  provider_options?: string[];
  default_model?: string;
}

export type AgentMcpSupport = "bridge" | "disabled";
export type AgentMcpAdapter = "openclaw-config" | "hermes-config" | "deepagents-config";

export interface AgentMcpCapability {
  support: AgentMcpSupport;
  adapter?: AgentMcpAdapter;
  reason?: string;
}

export interface AgentLegacyPaths {
  dockerfileBase: string | null;
  dockerfile: string | null;
  startScript: string | null;
  policy: string | null;
  plugin: string | null;
}

export type AgentVersionScheme = "semver" | "calendar";

export interface AgentDefinition {
  name: string;
  description?: string;
  display_name?: string;
  binary_path?: string;
  version_command?: string;
  expected_version?: string;
  version_scheme?: AgentVersionScheme;
  gateway_command?: string;
  runtime?: AgentRuntime;
  device_pairing?: boolean;
  phone_home_hosts?: string[];
  forward_ports?: number[];
  health_probe?: AgentHealthProbe;
  config?: ManifestRecord;
  deferred_onboarding?: boolean;
  inference?: AgentInference;
  mcp?: AgentMcpCapability;
  user_managed_files?: string[];
  _legacy_paths?: StringMap;
  agentDir: string;
  manifestPath: string;
  readonly displayName: string;
  readonly healthProbe: AgentHealthProbe | null;
  readonly forwardPort: number;
  readonly dashboard: AgentDashboard;
  readonly webAuth: AgentWebAuth;
  readonly dashboardUi?: AgentDashboardUi | null;
  readonly configPaths: AgentConfigPaths;
  readonly inferenceProviderOptions: string[];
  readonly mcpCapability: AgentMcpCapability;
  readonly skillIntegration?: AgentSkillIntegration | null;
  readonly userManagedFiles: string[];
  readonly versionCommand: string;
  readonly expectedVersion: string | null;
  readonly versionScheme?: AgentVersionScheme | null;
  readonly hasDevicePairing: boolean;
  readonly phoneHomeHosts: string[];
  readonly dockerfileBasePath: string | null;
  readonly dockerfilePath: string | null;
  readonly startScriptPath: string | null;
  readonly policyAdditionsPath: string | null;
  readonly pluginDir: string | null;
  readonly legacyPaths: AgentLegacyPaths | null;
}

export interface AgentChoice {
  name: string;
  displayName: string;
  description: string;
}
