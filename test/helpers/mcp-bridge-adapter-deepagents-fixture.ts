// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
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
  configIsDirectory: boolean;
  configIsFifo: boolean;
  configIsSocket: boolean;
  configIsSymlink: boolean;
  config: Record<string, unknown> | null;
  configText: string | null;
  legacyConfigExists: boolean;
  legacyConfig: Record<string, unknown> | null;
  legacyConfigText: string | null;
  managedParentIsSymlink: boolean;
  managedParentTargetText: string | null;
  managedSymlinkTargetExists: boolean;
  managedSymlinkTargetText: string | null;
  managedTargetReadAccessed: boolean;
}

export interface DeepAgentsManagedFixtureOptions {
  danglingSymlink?: boolean;
  directory?: boolean;
  fifo?: boolean;
  mode?: number;
  parentSymlink?: boolean;
  statAfterManagedEloopAsRegular?: boolean;
  swapAfterManagedOpen?: "fifo" | "symlink";
  swapAfterMissingManagedOpen?: "fifo" | "symlink";
  swapBeforeManagedLink?: string;
  swapOnManagedOpen?: "fifo" | "socket" | "symlink";
  swapOnManagedRead?: "fifo" | "symlink";
  swapOnManagedSeek?: string;
  symlink?: boolean;
  targetReadProbe?: boolean;
  timeoutMs?: number;
}

type ManagedSwap = {
  content?: string;
  kind: "fifo" | "regular" | "socket" | "symlink";
  phase:
    | "after-missing-open"
    | "after-open"
    | "before-link"
    | "before-open"
    | "eloop-regular-stat"
    | "read"
    | "seek";
};

function resolveManagedSwap(options: DeepAgentsManagedFixtureOptions): ManagedSwap | undefined {
  if (options.swapOnManagedOpen) {
    return { kind: options.swapOnManagedOpen, phase: "before-open" };
  }
  if (options.swapAfterManagedOpen) {
    return { kind: options.swapAfterManagedOpen, phase: "after-open" };
  }
  if (options.swapAfterMissingManagedOpen) {
    return { kind: options.swapAfterMissingManagedOpen, phase: "after-missing-open" };
  }
  if (options.swapOnManagedRead) {
    return { kind: options.swapOnManagedRead, phase: "read" };
  }
  if (options.statAfterManagedEloopAsRegular) {
    return { kind: "symlink", phase: "eloop-regular-stat" };
  }
  if (options.swapBeforeManagedLink !== undefined) {
    return { content: options.swapBeforeManagedLink, kind: "regular", phase: "before-link" };
  }
  if (options.swapOnManagedSeek !== undefined) {
    return { content: options.swapOnManagedSeek, kind: "regular", phase: "seek" };
  }
  return undefined;
}

function createFifo(target: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fifo = spawnSync("mkfifo", [target], { encoding: "utf-8", timeout: 5000 });
  if (fifo.status !== 0) throw new Error(fifo.stderr || "could not create managed fixture FIFO");
  fs.chmodSync(target, mode);
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForPath(target: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  do {
    if (fs.existsSync(target)) return true;
    pause(10);
  } while (Date.now() < deadline);
  return fs.existsSync(target);
}

function startTargetReadProbe(target: string, ready: string, accessed: string) {
  const script = [
    "import os, sys",
    "open(sys.argv[2], 'x').close()",
    "descriptor = os.open(sys.argv[1], os.O_WRONLY)",
    "os.close(descriptor)",
    "open(sys.argv[3], 'x').close()",
  ].join("\n");
  const probe = spawn("python3", ["-I", "-c", script, target, ready, accessed], {
    stdio: "ignore",
  });
  if (!waitForPath(ready, 1000)) {
    probe.kill("SIGTERM");
    throw new Error("managed target-read probe did not become ready");
  }
  pause(50);
  return probe;
}

function createDeepAgentsFixturePythonExecutable(
  fixtureRoot: string,
  configPath: string,
  legacyConfigPath: string,
  managedSymlinkTarget: string,
  runtimeKind: "v2" | "legacy" | "unknown",
  managedSwap?: ManagedSwap,
): { executablePath: string; scriptPath: string } {
  const executablePath = path.join(fixtureRoot, "managed-swap-python");
  const scriptPath = path.join(fixtureRoot, "managed-swap-wrapper.py");
  const runtimeConfigPath =
    runtimeKind === "v2"
      ? configPath
      : runtimeKind === "legacy"
        ? legacyConfigPath
        : path.join(fixtureRoot, "unknown-runtime-config.json");
  const runtimePackagePath = path.join(fixtureRoot, "deepagents_code");
  fs.mkdirSync(runtimePackagePath);
  fs.writeFileSync(path.join(runtimePackagePath, "__init__.py"), "", { mode: 0o600 });
  fs.writeFileSync(
    path.join(runtimePackagePath, "_nemoclaw_managed.py"),
    `_MCP_CONFIG_FILE = ${JSON.stringify(runtimeConfigPath)}\n`,
    { mode: 0o600 },
  );
  const wrapper = [
    "import os",
    "import socket",
    "import sys",
    `fixture_root = ${JSON.stringify(fixtureRoot)}`,
    `managed_path = ${JSON.stringify(configPath)}`,
    `managed_target = ${JSON.stringify(managedSymlinkTarget)}`,
    `managed_swap_kind = ${JSON.stringify(managedSwap?.kind ?? "")}`,
    `managed_swap_phase = ${JSON.stringify(managedSwap?.phase ?? "")}`,
    `managed_swap_content = ${JSON.stringify(managedSwap?.content ?? "")}`,
    "managed_eloop_stage = 0",
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
    "def replace_managed_symlink_with_regular():",
    "    global managed_eloop_stage",
    "    os.unlink(managed_path)",
    "    with open(managed_target, 'rb') as source, open(managed_path, 'wb') as replacement:",
    "        replacement.write(source.read())",
    "    os.chmod(managed_path, 0o600)",
    "    managed_eloop_stage = 1",
    "def restore_managed_symlink():",
    "    global managed_eloop_stage",
    "    os.unlink(managed_path)",
    "    os.symlink(managed_target, managed_path)",
    "    managed_eloop_stage = 2",
    "def managed_profile(_frame, event, target):",
    "    if managed_swap_phase == 'eloop-regular-stat':",
    "        if managed_eloop_stage == 0 and event == 'c_exception' and target is os.open:",
    "            replace_managed_symlink_with_regular()",
    "        elif managed_eloop_stage == 1 and event == 'c_return' and target is os.stat:",
    "            restore_managed_symlink()",
    "        return",
    "    if managed_swapped:",
    "        return",
    "    if managed_swap_phase == 'before-open' and event == 'c_call' and target is os.open:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'after-open' and event == 'c_return' and target is os.open and _frame.f_code.co_name == 'open_managed_projection':",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'after-missing-open' and event == 'c_exception' and target is os.open:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'read' and event == 'c_call' and target is os.read:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'before-link' and event == 'c_call' and target is os.link:",
    "        replace_managed_path()",
    "    elif managed_swap_phase == 'seek' and event == 'c_call' and target is os.lseek:",
    "        replace_managed_path()",
    "source = sys.stdin.read()",
    "namespace = {'__name__': '__main__'}",
    "sys.path.insert(0, fixture_root)",
    "if managed_swap_phase:",
    "    sys.setprofile(managed_profile)",
    "try:",
    "    exec(compile(source, '<nemoclaw-managed-command>', 'exec'), namespace)",
    "finally:",
    "    sys.setprofile(None)",
    "    if managed_swap_phase == 'eloop-regular-stat' and managed_eloop_stage == 1:",
    "        restore_managed_symlink()",
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
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(fixtureRoot, "nemoclaw-deepagents-mcp-")));
  const configPath = path.join(tmp, ".deepagents", ".nemoclaw-mcp.json");
  const managedParentPath = path.dirname(configPath);
  const managedParentTarget = path.join(tmp, "managed-parent-target");
  const managedParentTargetConfig = path.join(managedParentTarget, path.basename(configPath));
  const managedSymlinkTarget = path.join(tmp, "managed-projection-target.json");
  const managedTargetReadReady = path.join(tmp, "managed-target-read-ready");
  const managedTargetReadAccess = path.join(tmp, "managed-target-read-accessed");
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
  const managedTargetReadPath = managedOptions.targetReadProbe
    ? managedOptions.parentSymlink
      ? managedParentTargetConfig
      : managedSymlink
        ? managedSymlinkTarget
        : null
    : null;
  if (managedOptions.targetReadProbe && managedTargetReadPath === null) {
    throw new Error("targetReadProbe requires a projection or parent symlink");
  }
  const managedInitialPath = managedSymlink ? managedSymlinkTarget : configPath;
  if (managedOptions.parentSymlink) {
    fs.mkdirSync(managedParentTarget, { recursive: true });
    if (managedTargetReadPath === managedParentTargetConfig) {
      createFifo(managedParentTargetConfig, managedOptions.mode);
    } else {
      initializeConfig(managedParentTargetConfig, initialConfig, managedOptions.mode);
    }
    fs.symlinkSync(managedParentTarget, managedParentPath);
  } else if (managedOptions.directory) {
    fs.mkdirSync(configPath, { recursive: true, mode: managedOptions.mode ?? 0o700 });
  } else if (managedOptions.fifo) {
    createFifo(configPath, managedOptions.mode);
  } else {
    if (managedTargetReadPath === managedSymlinkTarget) {
      createFifo(managedSymlinkTarget, managedOptions.mode);
    } else if (!managedOptions.danglingSymlink && managedSwap?.phase !== "after-missing-open") {
      initializeConfig(managedInitialPath, initialConfig, managedOptions.mode);
      if (initialConfig !== undefined)
        fs.chmodSync(managedInitialPath, managedOptions.mode ?? 0o600);
    }
    if (managedSwap?.phase === "after-missing-open") {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
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
  let targetReadProbe: ReturnType<typeof spawn> | null = null;
  try {
    if (managedTargetReadPath !== null) {
      targetReadProbe = startTargetReadProbe(
        managedTargetReadPath,
        managedTargetReadReady,
        managedTargetReadAccess,
      );
    }
    const fixturePython = createDeepAgentsFixturePythonExecutable(
      tmp,
      configPath,
      legacyConfigPath,
      managedSymlinkTarget,
      runtimeKind,
      managedSwap,
    );
    const fixtureCommand = command
      .replaceAll(DEEPAGENTS_MCP_CONFIG_PATH, configPath)
      .replaceAll("/sandbox/.deepagents/.mcp.json", legacyConfigPath)
      .replaceAll("/opt/venv/bin/python3", fixturePython.executablePath);
    const result = spawnSync("bash", ["-c", fixtureCommand], {
      encoding: "utf-8",
      env: {
        ...process.env,
        DEEPAGENTS_FIXTURE_PYTHON_WRAPPER: fixturePython.scriptPath,
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
    let managedParentIsSymlink = false;
    try {
      managedParentIsSymlink = fs.lstatSync(managedParentPath).isSymbolicLink();
    } catch {
      // A missing projection parent cannot redirect the managed path.
    }
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
    const readRegularFile = (target: string): string | null => {
      try {
        return fs.lstatSync(target).isFile() ? fs.readFileSync(target, "utf-8") : null;
      } catch {
        return null;
      }
    };
    const managedSymlinkTargetText = readRegularFile(managedSymlinkTarget);
    const managedParentTargetText = readRegularFile(managedParentTargetConfig);
    const managedTargetReadAccessed =
      managedTargetReadPath !== null && waitForPath(managedTargetReadAccess, 200);
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
      configIsDirectory,
      configIsFifo,
      configIsSocket,
      configIsSymlink,
      config: parseConfigText(configText),
      configText,
      legacyConfigExists,
      legacyConfig: parseConfigText(legacyConfigText),
      legacyConfigText,
      managedParentIsSymlink,
      managedParentTargetText,
      managedSymlinkTargetExists,
      managedSymlinkTargetText,
      managedTargetReadAccessed,
    };
  } finally {
    targetReadProbe?.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
