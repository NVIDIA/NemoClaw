// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEEPAGENTS_MCP_CONFIG_PATH } from "../../src/lib/actions/sandbox/mcp-bridge-adapter-status";
import type { McpBridgeEntry } from "../../src/lib/state/registry";

export const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "langchain-deepagents-code",
  adapter: "deepagents-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

export interface DeepAgentsConfigCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  configExists: boolean;
  config: Record<string, unknown> | null;
  configText: string | null;
  legacyConfigExists: boolean;
  legacyConfig: Record<string, unknown> | null;
  legacyConfigText: string | null;
  managedSymlinkTargetExists: boolean;
  managedSymlinkTargetText: string | null;
}

export interface DeepAgentsManagedFixtureOptions {
  fifo?: boolean;
  mode?: number;
  symlink?: boolean;
}

export function runDeepAgentsConfigCommand(
  command: string,
  initialConfig?: Record<string, unknown> | string,
  runtimeKind: "v2" | "legacy" | "unknown" = "v2",
  initialLegacyConfig?: Record<string, unknown> | string,
  initialLegacyMode = 0o600,
  managedOptions: DeepAgentsManagedFixtureOptions = {},
): DeepAgentsConfigCommandResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepagents-mcp-"));
  const configPath = path.join(tmp, ".deepagents", ".nemoclaw-mcp.json");
  const managedSymlinkTarget = path.join(tmp, "managed-projection-target.json");
  const legacyConfigPath = path.join(tmp, ".deepagents", ".mcp.json");
  const initializeConfig = (
    target: string,
    value: Record<string, unknown> | string | undefined,
    mode = 0o600,
  ) => {
    if (value === undefined) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
      { mode },
    );
  };
  const managedInitialPath = managedOptions.symlink ? managedSymlinkTarget : configPath;
  if (managedOptions.fifo) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const fifo = spawnSync("mkfifo", [configPath], { encoding: "utf-8", timeout: 5000 });
    if (fifo.status !== 0) throw new Error(fifo.stderr || "could not create managed fixture FIFO");
    fs.chmodSync(configPath, managedOptions.mode ?? 0o600);
  } else {
    initializeConfig(managedInitialPath, initialConfig, managedOptions.mode);
    if (initialConfig !== undefined) fs.chmodSync(managedInitialPath, managedOptions.mode ?? 0o600);
    if (managedOptions.symlink && initialConfig !== undefined) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(managedSymlinkTarget, configPath);
    }
  }
  initializeConfig(legacyConfigPath, initialLegacyConfig);
  if (initialLegacyConfig !== undefined) fs.chmodSync(legacyConfigPath, initialLegacyMode);
  try {
    const fixtureCommand = command
      .replaceAll(DEEPAGENTS_MCP_CONFIG_PATH, configPath)
      .replaceAll("/sandbox/.deepagents/.mcp.json", legacyConfigPath)
      .replaceAll("/opt/venv/bin/python3", "python3")
      .replace(
        'runtime_kind = "auto"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR',
        `runtime_kind = "${runtimeKind}"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR`,
      );
    const result = spawnSync("bash", ["-c", fixtureCommand], { encoding: "utf-8", timeout: 5000 });
    const configExists = fs.existsSync(configPath);
    const legacyConfigExists = fs.existsSync(legacyConfigPath);
    const configIsFifo = configExists && fs.lstatSync(configPath).isFIFO();
    const configText = configExists && !configIsFifo ? fs.readFileSync(configPath, "utf-8") : null;
    const managedSymlinkTargetExists = fs.existsSync(managedSymlinkTarget);
    const managedSymlinkTargetText = managedSymlinkTargetExists
      ? fs.readFileSync(managedSymlinkTarget, "utf-8")
      : null;
    const legacyConfigText = legacyConfigExists ? fs.readFileSync(legacyConfigPath, "utf-8") : null;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      configExists,
      config: configText ? (JSON.parse(configText) as Record<string, unknown>) : null,
      configText,
      legacyConfigExists,
      legacyConfig: legacyConfigText
        ? (JSON.parse(legacyConfigText) as Record<string, unknown>)
        : null,
      legacyConfigText,
      managedSymlinkTargetExists,
      managedSymlinkTargetText,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
