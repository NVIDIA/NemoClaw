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
  swapAfterManagedOpenError?: "fifo" | "symlink";
  swapBeforeManagedLink?: string;
  swapRejectedManagedSymlinkToRegular?: string;
  swapOnManagedOpen?: "fifo" | "socket" | "symlink";
  swapOnManagedRead?: "fifo" | "symlink";
  swapOnManagedSeek?: string;
  symlink?: boolean;
  timeoutMs?: number;
}

type ManagedSwap = {
  content?: string;
  kind: "fifo" | "regular" | "socket" | "symlink";
  phase: "after-open" | "before-link" | "before-open" | "open-error" | "read" | "seek";
  restoreSymlink?: boolean;
};

function resolveManagedSwap(options: DeepAgentsManagedFixtureOptions): ManagedSwap | undefined {
  if (options.swapOnManagedOpen) {
    return { kind: options.swapOnManagedOpen, phase: "before-open" };
  }
  if (options.swapAfterManagedOpen) {
    return { kind: options.swapAfterManagedOpen, phase: "after-open" };
  }
  if (options.swapAfterManagedOpenError) {
    return { kind: options.swapAfterManagedOpenError, phase: "open-error" };
  }
  if (options.swapRejectedManagedSymlinkToRegular !== undefined) {
    return {
      content: options.swapRejectedManagedSymlinkToRegular,
      kind: "regular",
      phase: "open-error",
      restoreSymlink: true,
    };
  }
  if (options.swapOnManagedRead) {
    return { kind: options.swapOnManagedRead, phase: "read" };
  }
  if (options.swapBeforeManagedLink !== undefined) {
    return { content: options.swapBeforeManagedLink, kind: "regular", phase: "before-link" };
  }
  if (options.swapOnManagedSeek !== undefined) {
    return { content: options.swapOnManagedSeek, kind: "regular", phase: "seek" };
  }
  return undefined;
}

function createManagedSwapPythonExecutable(
  fixtureRoot: string,
  configPath: string,
  managedSymlinkTarget: string,
  managedSwap: ManagedSwap,
): { executablePath: string; scriptPath: string } {
  const executablePath = path.join(fixtureRoot, "managed-swap-python");
  const scriptPath = path.join(fixtureRoot, "managed-swap-wrapper.py");
  const wrapper = [
    "import os",
    "import socket",
    "import sys",
    `managed_path = ${JSON.stringify(configPath)}`,
    `managed_target = ${JSON.stringify(managedSymlinkTarget)}`,
    `managed_swap_kind = ${JSON.stringify(managedSwap.kind)}`,
    `managed_swap_phase = ${JSON.stringify(managedSwap.phase)}`,
    `managed_swap_content = ${JSON.stringify(managedSwap.content ?? "")}`,
    `managed_restore_symlink = ${managedSwap.restoreSymlink === true ? "True" : "False"}`,
    "managed_socket = None",
    "managed_swapped = False",
    "def replace_managed_path():",
    "    global managed_socket, managed_swapped",
    "    if managed_swapped:",
    "        return",
    "    managed_swapped = True",
    "    try:",
    "        os.unlink(managed_path)",
    "    except FileNotFoundError:",
    "        pass",
    "    if managed_swap_kind == 'symlink':",
    "        os.symlink(managed_target, managed_path)",
    "    elif managed_swap_kind == 'fifo':",
    "        os.mkfifo(managed_path, 0o600)",
    "    elif managed_swap_kind == 'socket':",
    "        managed_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
    "        managed_socket.bind(managed_path)",
    "    else:",
    "        with open(managed_path, 'w', encoding='utf-8') as replacement:",
    "            replacement.write(managed_swap_content)",
    "        os.chmod(managed_path, 0o600)",
    "def restore_managed_symlink():",
    "    if not managed_restore_symlink or not managed_swapped:",
    "        return",
    "    try:",
    "        os.unlink(managed_path)",
    "    except FileNotFoundError:",
    "        pass",
    "    os.symlink(managed_target, managed_path)",
    "def managed_profile(_frame, event, target):",
    "    if managed_swapped:",
    "        return",
    "    if managed_swap_phase == 'before-open' and event == 'c_call' and target is os.open:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'after-open' and event == 'c_return' and target is os.open:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'open-error' and event == 'c_exception' and target is os.open:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'read' and event == 'c_call' and target is os.read:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'before-link' and event == 'c_call' and target is os.link:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'seek' and event == 'c_call' and target is os.lseek:",
    "        replace_managed_path()",
    "source = sys.stdin.read()",
    "namespace = {'__name__': '__main__'}",
    "sys.setprofile(managed_profile)",
    "try:",
    "    exec(compile(source, '<nemoclaw-managed-command>', 'exec'), namespace)",
    "finally:",
    "    sys.setprofile(None)",
    "    restore_managed_symlink()",
    "",
  ].join("\n");
  fs.writeFileSync(scriptPath, wrapper, { mode: 0o600 });
  fs.writeFileSync(
    executablePath,
    '#!/bin/sh\nexec python3 -I "$DEEPAGENTS_FIXTURE_PYTHON_WRAPPER" "$@"\n',
    { mode: 0o700 },
  );
  return { executablePath, scriptPath };
}

export function runDeepAgentsConfigCommand(
  command: string,
  initialConfig?: Record<string, unknown> | string,
  runtimeKind: "v2" | "legacy" | "unknown" = "v2",
  initialLegacyConfig?: Record<string, unknown> | string,
  initialLegacyMode = 0o600,
  managedOptions: DeepAgentsManagedFixtureOptions = {},
): DeepAgentsConfigCommandResult {
  const managedSwap = resolveManagedSwap(managedOptions);
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
  const managedSymlink =
    managedOptions.symlink === true ||
    managedOptions.danglingSymlink === true ||
    managedOptions.swapRejectedManagedSymlinkToRegular !== undefined;
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
  if (managedSwap?.phase === "open-error") {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
  }
  initializeConfig(legacyConfigPath, initialLegacyConfig);
  if (initialLegacyConfig !== undefined) fs.chmodSync(legacyConfigPath, initialLegacyMode);
  try {
    const managedSwapPython = managedSwap
      ? createManagedSwapPythonExecutable(tmp, configPath, managedSymlinkTarget, managedSwap)
      : null;
    const fixtureCommand = command
      .replaceAll(DEEPAGENTS_MCP_CONFIG_PATH, configPath)
      .replaceAll("/sandbox/.deepagents/.mcp.json", legacyConfigPath)
      .replaceAll("/opt/venv/bin/python3", managedSwapPython?.executablePath ?? "python3")
      .replace(
        'runtime_kind = "auto"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR',
        `runtime_kind = "${runtimeKind}"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR`,
      );
    const result = spawnSync("bash", ["-c", fixtureCommand], {
      encoding: "utf-8",
      env: {
        ...process.env,
        ...(managedSwapPython
          ? { DEEPAGENTS_FIXTURE_PYTHON_WRAPPER: managedSwapPython.scriptPath }
          : {}),
      },
      timeout: managedOptions.timeoutMs ?? 5000,
    });
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
      configExists && !configIsFifo && !configIsSocket && !configIsSymlink && !configIsDirectory
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
