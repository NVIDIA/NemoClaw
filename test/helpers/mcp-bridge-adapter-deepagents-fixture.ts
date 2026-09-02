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
  managedSymlinkTargetExists: boolean;
  managedSymlinkTargetText: string | null;
  managedTargetReadAccessed: boolean;
}

export interface DeepAgentsManagedFixtureOptions {
  danglingSymlink?: boolean;
  directory?: boolean;
  fifo?: boolean;
  mode?: number;
  swapAfterManagedEloop?: boolean;
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
    | "after-missing-projection-open"
    | "after-projection-eloop"
    | "after-projection-open"
    | "before-projection-open"
    | "projection-publication-begins"
    | "projection-read-begins"
    | "projection-rewrite-begins";
};

function resolveManagedSwap(options: DeepAgentsManagedFixtureOptions): ManagedSwap | undefined {
  if (options.swapOnManagedOpen) {
    return { kind: options.swapOnManagedOpen, phase: "before-projection-open" };
  }
  if (options.swapAfterManagedOpen) {
    return { kind: options.swapAfterManagedOpen, phase: "after-projection-open" };
  }
  if (options.swapAfterMissingManagedOpen) {
    return {
      kind: options.swapAfterMissingManagedOpen,
      phase: "after-missing-projection-open",
    };
  }
  if (options.swapOnManagedRead) {
    return { kind: options.swapOnManagedRead, phase: "projection-read-begins" };
  }
  if (options.swapAfterManagedEloop) {
    return { kind: "symlink", phase: "after-projection-eloop" };
  }
  if (options.swapBeforeManagedLink !== undefined) {
    return {
      content: options.swapBeforeManagedLink,
      kind: "regular",
      phase: "projection-publication-begins",
    };
  }
  if (options.swapOnManagedSeek !== undefined) {
    return {
      content: options.swapOnManagedSeek,
      kind: "regular",
      phase: "projection-rewrite-begins",
    };
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
    "import errno",
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
    "managed_descriptor = None",
    "managed_entry_name = os.path.basename(managed_path)",
    "managed_real_link = os.link",
    "managed_real_lseek = os.lseek",
    "managed_real_open = os.open",
    "managed_real_read = os.read",
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
    "def is_managed_entry(value, directory_descriptor):",
    "    try:",
    "        candidate = os.fspath(value)",
    "        return candidate == managed_path if directory_descriptor is None else candidate == managed_entry_name",
    "    except TypeError:",
    "        return False",
    "def managed_boundary_open(value, flags, mode=0o777, *, dir_fd=None):",
    "    global managed_descriptor",
    "    projection_entry = is_managed_entry(value, dir_fd)",
    "    if projection_entry and managed_swap_phase == 'before-projection-open':",
    "        replace_managed_path()",
    "    try:",
    "        if dir_fd is None:",
    "            descriptor = managed_real_open(value, flags, mode)",
    "        else:",
    "            descriptor = managed_real_open(value, flags, mode, dir_fd=dir_fd)",
    "    except OSError as exc:",
    "        if projection_entry and managed_swap_phase == 'after-missing-projection-open' and isinstance(exc, FileNotFoundError):",
    "            replace_managed_path()",
    "        elif projection_entry and managed_swap_phase == 'after-projection-eloop' and exc.errno == errno.ELOOP:",
    "            replace_managed_symlink_with_regular()",
    "        raise",
    "    if projection_entry:",
    "        managed_descriptor = descriptor",
    "        if managed_swap_phase == 'after-projection-open':",
    "            replace_managed_path()",
    "    return descriptor",
    "def managed_boundary_read(descriptor, length):",
    "    if managed_swap_phase == 'projection-read-begins' and descriptor == managed_descriptor:",
    "        replace_managed_path()",
    "    return managed_real_read(descriptor, length)",
    "def managed_boundary_link(source, destination, *args, **kwargs):",
    "    if managed_swap_phase == 'projection-publication-begins' and is_managed_entry(destination, kwargs.get('dst_dir_fd')):",
    "        replace_managed_path()",
    "    return managed_real_link(source, destination, *args, **kwargs)",
    "def managed_boundary_lseek(descriptor, position, how):",
    "    if managed_swap_phase == 'projection-rewrite-begins' and descriptor == managed_descriptor:",
    "        replace_managed_path()",
    "    return managed_real_lseek(descriptor, position, how)",
    "def install_managed_boundaries():",
    "    if not managed_swap_phase:",
    "        return",
    "    os.link = managed_boundary_link",
    "    os.lseek = managed_boundary_lseek",
    "    os.open = managed_boundary_open",
    "    os.read = managed_boundary_read",
    "def restore_managed_boundaries():",
    "    os.link = managed_real_link",
    "    os.lseek = managed_real_lseek",
    "    os.open = managed_real_open",
    "    os.read = managed_real_read",
    "source = sys.stdin.read()",
    "namespace = {'__name__': '__main__'}",
    "sys.path.insert(0, fixture_root)",
    "install_managed_boundaries()",
    "try:",
    "    exec(compile(source, '<nemoclaw-managed-command>', 'exec'), namespace)",
    "finally:",
    "    restore_managed_boundaries()",
    "    if managed_swap_phase == 'after-projection-eloop' and managed_eloop_stage == 1:",
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
  runtimeEnvironment: NodeJS.ProcessEnv = {},
): DeepAgentsConfigCommandResult {
  const managedSwap = resolveManagedSwap(managedOptions);
  const fixtureRoot = managedSwap?.kind === "socket" ? "/tmp" : os.tmpdir();
  const tmp = fs.mkdtempSync(path.join(fixtureRoot, "nemoclaw-deepagents-mcp-"));
  const configPath = path.join(tmp, ".deepagents", ".nemoclaw-mcp.json");
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
    ? managedSymlink
      ? managedSymlinkTarget
      : null
    : null;
  if (managedOptions.targetReadProbe && managedTargetReadPath === null) {
    throw new Error("targetReadProbe requires a projection symlink");
  }
  const managedInitialPath = managedSymlink ? managedSymlinkTarget : configPath;
  if (managedOptions.directory) {
    fs.mkdirSync(configPath, { recursive: true, mode: managedOptions.mode ?? 0o700 });
  } else if (managedOptions.fifo) {
    createFifo(configPath, managedOptions.mode);
  } else {
    if (managedTargetReadPath === managedSymlinkTarget) {
      createFifo(managedSymlinkTarget, managedOptions.mode);
    } else if (
      !managedOptions.danglingSymlink &&
      managedSwap?.phase !== "after-missing-projection-open"
    ) {
      initializeConfig(managedInitialPath, initialConfig, managedOptions.mode);
      if (initialConfig !== undefined)
        fs.chmodSync(managedInitialPath, managedOptions.mode ?? 0o600);
    }
    if (managedSwap?.phase === "after-missing-projection-open") {
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
    const canonicalEnvironment = Object.fromEntries(
      [...command.matchAll(/openshell:resolve:env:([A-Za-z_][A-Za-z0-9_]*)/gu)].map(
        ([, name]) => [name!, `openshell:resolve:env:${name!}`],
      ),
    );
    const fixtureCommandPath = path.join(tmp, "managed-command.sh");
    fs.writeFileSync(fixtureCommandPath, fixtureCommand, { mode: 0o600 });
    const result = spawnSync("bash", [fixtureCommandPath], {
      encoding: "utf-8",
      env: {
        ...process.env,
        ...canonicalEnvironment,
        ...runtimeEnvironment,
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
      let descriptor: number | null = null;
      try {
        descriptor = fs.openSync(
          target,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        return fs.fstatSync(descriptor).isFile() ? fs.readFileSync(descriptor, "utf-8") : null;
      } catch {
        return null;
      } finally {
        if (descriptor !== null) fs.closeSync(descriptor);
      }
    };
    const managedSymlinkTargetText =
      managedTargetReadPath === managedSymlinkTarget ? null : readRegularFile(managedSymlinkTarget);
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
      managedSymlinkTargetExists,
      managedSymlinkTargetText,
      managedTargetReadAccessed,
    };
  } finally {
    targetReadProbe?.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
