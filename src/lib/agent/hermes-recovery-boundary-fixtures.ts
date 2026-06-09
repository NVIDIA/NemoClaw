// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared test fixtures for the Hermes recovery-boundary test suite. Non-test
// module name (no `.test.ts`) keeps Vitest from collecting it directly while
// the colocated layout lets every boundary-test file import from a single
// agent-shape definition.

import type { AgentDefinition } from "./defs";

export function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    displayName: "Test Agent",
    binary_path: "/usr/local/bin/test-agent",
    gateway_command: "test-agent gateway run",
    healthProbe: { url: "http://127.0.0.1:19000/", port: 19000, timeout_seconds: 5 },
    forwardPort: 19000,
    dashboard: { kind: "ui", label: "UI", path: "/", healthPath: "/health", auth: "url_token" },
    configPaths: {
      dir: "/tmp/agent",
      configFile: "/tmp/agent/config.yaml",
      envFile: null,
      format: "yaml",
    },
    inferenceProviderOptions: [],
    stateDirs: [],
    stateFiles: [],
    versionCommand: "test-agent --version",
    expectedVersion: null,
    hasDevicePairing: false,
    phoneHomeHosts: [],
    messagingPlatforms: [],
    dockerfileBasePath: null,
    dockerfilePath: null,
    startScriptPath: null,
    policyAdditionsPath: null,
    policyPermissivePath: null,
    pluginDir: null,
    legacyPaths: null,
    agentDir: "/tmp/agent",
    manifestPath: "/tmp/agent/manifest.yaml",
    ...overrides,
  };
}

export const minimalAgent = makeAgent();
export const hermesAgent = makeAgent({
  name: "hermes",
  displayName: "Hermes Agent",
  binary_path: "/usr/local/bin/hermes",
  gateway_command: "hermes gateway run",
  healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 90 },
  forwardPort: 8642,
  configPaths: {
    dir: "/sandbox/.hermes",
    configFile: "/sandbox/.hermes/config.yaml",
    envFile: "/sandbox/.hermes/.env",
    format: "yaml",
  },
});
