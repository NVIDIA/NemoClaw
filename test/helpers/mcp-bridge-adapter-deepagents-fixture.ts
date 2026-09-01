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
  configIsFifo: boolean;
  configIsSocket: boolean;
  configIsSymlink: boolean;
  config: Record<string, unknown> | null;
  configText: string | null;
  legacyConfigExists: boolean;
  legacyConfig: Record<string, unknown> | null;
  legacyConfigText: string | null;
  managedSymlinkTargetExists: boolean;
  managedSymlinkTargetText: string | null;
}

export interface DeepAgentsManagedFixtureOptions {
  danglingSymlink?: boolean;
  directory?: boolean;
  fifo?: boolean;
  mode?: number;
  swapAfterManagedOpen?: "fifo" | "symlink";
  swapOnManagedOpen?: "fifo" | "socket" | "symlink";
  swapOnManagedRead?: "fifo" | "symlink";
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
  const managedSwap = managedOptions.swapOnManagedOpen
    ? { kind: managedOptions.swapOnManagedOpen, phase: "before-open" }
    : managedOptions.swapAfterManagedOpen
      ? { kind: managedOptions.swapAfterManagedOpen, phase: "after-open" }
      : managedOptions.swapOnManagedRead
        ? { kind: managedOptions.swapOnManagedRead, phase: "read" }
        : undefined;
  const fixtureRoot = managedSwap?.kind === "socket" ? "/tmp" : os.tmpdir();
  const tmp = fs.mkdtempSync(path.join(fixtureRoot, "nemoclaw-deepagents-mcp-"));
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
  const managedSymlink = managedOptions.symlink === true || managedOptions.danglingSymlink === true;
  const managedInitialPath = managedSymlink ? managedSymlinkTarget : configPath;
  if (managedOptions.directory) {
    fs.mkdirSync(configPath, { recursive: true, mode: managedOptions.mode ?? 0o700 });
  } else if (managedOptions.fifo) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const fifo = spawnSync("mkfifo", [configPath], { encoding: "utf-8", timeout: 5000 });
    if (fifo.status !== 0) throw new Error(fifo.stderr || "could not create managed fixture FIFO");
    fs.chmodSync(configPath, managedOptions.mode ?? 0o600);
  } else {
    if (!managedOptions.danglingSymlink) {
      initializeConfig(managedInitialPath, initialConfig, managedOptions.mode);
      if (initialConfig !== undefined)
        fs.chmodSync(managedInitialPath, managedOptions.mode ?? 0o600);
    }
    if (managedSymlink) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(managedSymlinkTarget, configPath);
    }
  }
  if (managedSwap?.kind === "symlink") {
    initializeConfig(managedSymlinkTarget, initialConfig, managedOptions.mode);
  }
  initializeConfig(legacyConfigPath, initialLegacyConfig);
  if (initialLegacyConfig !== undefined) fs.chmodSync(legacyConfigPath, initialLegacyMode);
  try {
    const managedSwapPrelude = managedSwap
      ? [
          "import os as _nemoclaw_test_os",
          "import socket as _nemoclaw_test_socket_module",
          `_nemoclaw_test_path = ${JSON.stringify(configPath)}`,
          `_nemoclaw_test_target = ${JSON.stringify(managedSymlinkTarget)}`,
          `_nemoclaw_test_swap = ${JSON.stringify(managedSwap.kind)}`,
          `_nemoclaw_test_phase = ${JSON.stringify(managedSwap.phase)}`,
          "_nemoclaw_test_real_open = _nemoclaw_test_os.open",
          "_nemoclaw_test_real_read = _nemoclaw_test_os.read",
          "_nemoclaw_test_descriptor = None",
          "_nemoclaw_test_socket = None",
          "_nemoclaw_test_swapped = False",
          "def _nemoclaw_test_replace_path():",
          "    global _nemoclaw_test_socket, _nemoclaw_test_swapped",
          "    if _nemoclaw_test_swapped:",
          "        return",
          "    _nemoclaw_test_swapped = True",
          "    _nemoclaw_test_os.unlink(_nemoclaw_test_path)",
          "    if _nemoclaw_test_swap == 'symlink':",
          "        _nemoclaw_test_os.symlink(_nemoclaw_test_target, _nemoclaw_test_path)",
          "    elif _nemoclaw_test_swap == 'fifo':",
          "        _nemoclaw_test_os.mkfifo(_nemoclaw_test_path, 0o600)",
          "    else:",
          "        _nemoclaw_test_socket = _nemoclaw_test_socket_module.socket(_nemoclaw_test_socket_module.AF_UNIX, _nemoclaw_test_socket_module.SOCK_STREAM)",
          "        _nemoclaw_test_socket.bind(_nemoclaw_test_path)",
          "def _nemoclaw_test_open(path, flags, *args, **kwargs):",
          "    global _nemoclaw_test_descriptor",
          "    managed = _nemoclaw_test_os.fspath(path) == _nemoclaw_test_path",
          "    if managed and _nemoclaw_test_phase == 'before-open':",
          "        _nemoclaw_test_replace_path()",
          "    descriptor = _nemoclaw_test_real_open(path, flags, *args, **kwargs)",
          "    if managed:",
          "        _nemoclaw_test_descriptor = descriptor",
          "        if _nemoclaw_test_phase == 'after-open':",
          "            _nemoclaw_test_replace_path()",
          "    return descriptor",
          "def _nemoclaw_test_read(descriptor, size):",
          "    if descriptor == _nemoclaw_test_descriptor and _nemoclaw_test_phase == 'read':",
          "        _nemoclaw_test_replace_path()",
          "    return _nemoclaw_test_real_read(descriptor, size)",
          "_nemoclaw_test_os.open = _nemoclaw_test_open",
          "_nemoclaw_test_os.read = _nemoclaw_test_read",
        ].join("\n")
      : "";
    const fixtureCommand = command
      .replace("<<'PY'\n", `<<'PY'\n${managedSwapPrelude}\n`)
      .replaceAll(DEEPAGENTS_MCP_CONFIG_PATH, configPath)
      .replaceAll("/sandbox/.deepagents/.mcp.json", legacyConfigPath)
      .replaceAll("/opt/venv/bin/python3", "python3")
      .replace(
        'runtime_kind = "auto"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR',
        `runtime_kind = "${runtimeKind}"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR`,
      );
    const result = spawnSync("bash", ["-c", fixtureCommand], { encoding: "utf-8", timeout: 5000 });
    let configStat: fs.Stats | null = null;
    try {
      configStat = fs.lstatSync(configPath);
    } catch {
      // A missing projection has no path type to report.
    }
    const configExists = configStat !== null;
    const legacyConfigExists = fs.existsSync(legacyConfigPath);
    const configIsFifo = configStat?.isFIFO() === true;
    const configIsSocket = configStat?.isSocket() === true;
    const configIsSymlink = configStat?.isSymbolicLink() === true;
    const configIsDirectory = configStat?.isDirectory() === true;
    const configText =
      configExists &&
      !configIsFifo &&
      !configIsSocket &&
      !configIsSymlink &&
      !configIsDirectory
        ? fs.readFileSync(configPath, "utf-8")
        : null;
    const managedSymlinkTargetExists = fs.existsSync(managedSymlinkTarget);
    const managedSymlinkTargetText = managedSymlinkTargetExists
      ? fs.readFileSync(managedSymlinkTarget, "utf-8")
      : null;
    const legacyConfigText = legacyConfigExists ? fs.readFileSync(legacyConfigPath, "utf-8") : null;
    const parseConfigText = (text: string | null): Record<string, unknown> | null => {
      if (!text) return null;
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    };
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      configExists,
      configIsFifo,
      configIsSocket,
      configIsSymlink,
      config: parseConfigText(configText),
      configText,
      legacyConfigExists,
      legacyConfig: parseConfigText(legacyConfigText),
      legacyConfigText,
      managedSymlinkTargetExists,
      managedSymlinkTargetText,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
