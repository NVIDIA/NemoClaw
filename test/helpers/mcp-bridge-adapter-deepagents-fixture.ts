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
  managedRaceIterations: number;
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
  raceAbsentPublication?: string;
  raceProjection?: "fifo" | "symlink";
  socket?: boolean;
  symlink?: boolean;
  targetReadProbe?: boolean;
  timeoutMs?: number;
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

type ManagedFixtureProcess = {
  child: ReturnType<typeof spawn>;
  finishedPath: string;
  resultPath: string;
  stopPath: string;
};

function startManagedFixtureProcess(
  fixtureRoot: string,
  label: string,
  script: string,
  args: string[],
): ManagedFixtureProcess {
  const readyPath = path.join(fixtureRoot, `${label}-ready`);
  const stopPath = path.join(fixtureRoot, `${label}-stop`);
  const finishedPath = path.join(fixtureRoot, `${label}-finished`);
  const resultPath = path.join(fixtureRoot, `${label}-result`);
  const child = spawn(
    "python3",
    ["-I", "-c", script, ...args, readyPath, stopPath, finishedPath, resultPath],
    { stdio: "ignore" },
  );
  if (!waitForPath(readyPath, 2000)) {
    child.kill("SIGTERM");
    throw new Error(`${label} did not become ready`);
  }
  pause(20);
  return { child, finishedPath, resultPath, stopPath };
}

function stopManagedFixtureProcess(process: ManagedFixtureProcess): number {
  if (!fs.existsSync(process.stopPath)) fs.writeFileSync(process.stopPath, "", { flag: "wx" });
  if (!waitForPath(process.finishedPath, 2000)) {
    process.child.kill("SIGTERM");
    throw new Error("managed fixture process did not stop");
  }
  process.child.kill("SIGTERM");
  const result = Number.parseInt(fs.readFileSync(process.resultPath, "utf-8"), 10);
  return Number.isFinite(result) ? result : 0;
}

function startManagedPathRace(
  fixtureRoot: string,
  managedPath: string,
  managedTarget: string,
  kind: "fifo" | "symlink",
  safeContent: string,
): ManagedFixtureProcess {
  const script = [
    "import base64, os, sys, time",
    "managed_path, managed_target, race_kind, encoded = sys.argv[1:5]",
    "ready, stop, finished, result = sys.argv[5:9]",
    "safe_content = base64.b64decode(encoded)",
    "safe_temp = managed_path + '.race-safe'",
    "unsafe_temp = managed_path + '.race-unsafe'",
    "def remove_temp(target):",
    "    try:",
    "        os.unlink(target)",
    "    except FileNotFoundError:",
    "        pass",
    "def replace_safe():",
    "    remove_temp(safe_temp)",
    "    descriptor = os.open(safe_temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)",
    "    try:",
    "        offset = 0",
    "        while offset < len(safe_content):",
    "            offset += os.write(descriptor, safe_content[offset:])",
    "        os.fsync(descriptor)",
    "    finally:",
    "        os.close(descriptor)",
    "    os.replace(safe_temp, managed_path)",
    "def replace_unsafe():",
    "    remove_temp(unsafe_temp)",
    "    if race_kind == 'symlink':",
    "        os.symlink(managed_target, unsafe_temp)",
    "    else:",
    "        os.mkfifo(unsafe_temp, 0o600)",
    "    os.replace(unsafe_temp, managed_path)",
    "iterations = 0",
    "replace_unsafe()",
    "open(ready, 'x').close()",
    "while not os.path.exists(stop):",
    "    replace_safe()",
    "    iterations += 1",
    "    replace_unsafe()",
    "    iterations += 1",
    "    time.sleep(0.0001)",
    "replace_unsafe()",
    "open(result, 'w', encoding='utf-8').write(str(iterations))",
    "open(finished, 'x').close()",
  ].join("\n");
  return startManagedFixtureProcess(fixtureRoot, "managed-path-race", script, [
    managedPath,
    managedTarget,
    kind,
    Buffer.from(safeContent).toString("base64"),
  ]);
}

function startAbsentPublicationRace(
  fixtureRoot: string,
  managedPath: string,
  managedTarget: string,
): ManagedFixtureProcess {
  const script = [
    "import os, sys, time",
    "managed_path, managed_target = sys.argv[1:3]",
    "ready, stop, finished, result = sys.argv[3:7]",
    "parent = os.path.dirname(managed_path)",
    "triggered = 0",
    "open(ready, 'x').close()",
    "while not os.path.exists(stop) and not triggered:",
    "    if os.path.isdir(parent):",
    "        try:",
    "            os.symlink(managed_target, managed_path)",
    "            triggered = 1",
    "        except FileExistsError:",
    "            pass",
    "    time.sleep(0.0001)",
    "while not os.path.exists(stop):",
    "    time.sleep(0.001)",
    "open(result, 'w', encoding='utf-8').write(str(triggered))",
    "open(finished, 'x').close()",
  ].join("\n");
  return startManagedFixtureProcess(fixtureRoot, "managed-publication-race", script, [
    managedPath,
    managedTarget,
  ]);
}

function startManagedSocket(fixtureRoot: string, managedPath: string): ManagedFixtureProcess {
  const script = [
    "import os, socket, sys, time",
    "managed_path = sys.argv[1]",
    "ready, stop, finished, result = sys.argv[2:6]",
    "os.makedirs(os.path.dirname(managed_path), exist_ok=True)",
    "managed_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
    "managed_socket.bind(managed_path)",
    "open(ready, 'x').close()",
    "while not os.path.exists(stop):",
    "    time.sleep(0.001)",
    "managed_socket.close()",
    "open(result, 'w', encoding='utf-8').write('1')",
    "open(finished, 'x').close()",
  ].join("\n");
  return startManagedFixtureProcess(fixtureRoot, "managed-socket", script, [managedPath]);
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
  runtimeKind: "v2" | "legacy" | "unknown",
): { executablePath: string; scriptPath: string } {
  const executablePath = path.join(fixtureRoot, "fixture-python");
  const scriptPath = path.join(fixtureRoot, "fixture-wrapper.py");
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
    "import sys",
    `fixture_root = ${JSON.stringify(fixtureRoot)}`,
    "source = sys.stdin.read()",
    "namespace = {'__name__': '__main__'}",
    "sys.path.insert(0, fixture_root)",
    "exec(compile(source, '<nemoclaw-managed-command>', 'exec'), namespace)",
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
  const activeFixtureProcesses = [
    managedOptions.raceAbsentPublication !== undefined,
    managedOptions.raceProjection !== undefined,
    managedOptions.socket === true,
  ].filter(Boolean).length;
  if (activeFixtureProcesses > 1) {
    throw new Error("managed fixture process options are mutually exclusive");
  }
  const fixtureRoot = managedOptions.socket ? "/tmp" : os.tmpdir();
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
  } else if (managedOptions.socket) {
    // The socket holder creates the path after the rest of the fixture is ready.
  } else {
    if (managedTargetReadPath === managedSymlinkTarget) {
      createFifo(managedSymlinkTarget, managedOptions.mode);
    } else if (
      !managedOptions.danglingSymlink &&
      managedOptions.raceAbsentPublication === undefined
    ) {
      initializeConfig(managedInitialPath, initialConfig, managedOptions.mode);
      if (initialConfig !== undefined)
        fs.chmodSync(managedInitialPath, managedOptions.mode ?? 0o600);
    }
    if (managedSymlink) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.symlinkSync(managedSymlinkTarget, configPath);
    }
  }
  if (managedOptions.raceProjection === "symlink") {
    initializeConfig(managedSymlinkTarget, initialConfig, managedOptions.mode);
  }
  if (managedOptions.raceAbsentPublication !== undefined) {
    initializeConfig(managedSymlinkTarget, managedOptions.raceAbsentPublication);
  }
  initializeConfig(legacyConfigPath, initialLegacyConfig);
  if (initialLegacyConfig !== undefined) fs.chmodSync(legacyConfigPath, initialLegacyMode);
  let targetReadProbe: ReturnType<typeof spawn> | null = null;
  let managedRace: ManagedFixtureProcess | null = null;
  let socketFixture: ManagedFixtureProcess | null = null;
  let managedRaceIterations = 0;
  try {
    if (managedTargetReadPath !== null) {
      targetReadProbe = startTargetReadProbe(
        managedTargetReadPath,
        managedTargetReadReady,
        managedTargetReadAccess,
      );
    }
    if (managedOptions.socket) {
      socketFixture = startManagedSocket(tmp, configPath);
    } else if (managedOptions.raceProjection) {
      if (initialConfig === undefined) throw new Error("raceProjection requires initialConfig");
      const safeContent =
        typeof initialConfig === "string"
          ? initialConfig
          : `${JSON.stringify(initialConfig, null, 2)}\n`;
      managedRace = startManagedPathRace(
        tmp,
        configPath,
        managedSymlinkTarget,
        managedOptions.raceProjection,
        safeContent,
      );
    } else if (managedOptions.raceAbsentPublication !== undefined) {
      managedRace = startAbsentPublicationRace(tmp, configPath, managedSymlinkTarget);
    }
    const fixturePython = createDeepAgentsFixturePythonExecutable(
      tmp,
      configPath,
      legacyConfigPath,
      runtimeKind,
    );
    const fixtureCommand = command
      .replaceAll(DEEPAGENTS_MCP_CONFIG_PATH, configPath)
      .replaceAll("/sandbox/.deepagents/.mcp.json", legacyConfigPath)
      .replaceAll("/opt/venv/bin/python3", fixturePython.executablePath);
    const canonicalEnvironment = Object.fromEntries(
      [...command.matchAll(/openshell:resolve:env:([A-Za-z_][A-Za-z0-9_]*)/gu)].map(([, name]) => [
        name!,
        `openshell:resolve:env:${name!}`,
      ]),
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
    if (managedRace !== null) {
      managedRaceIterations = stopManagedFixtureProcess(managedRace);
      managedRace = null;
    }
    if (socketFixture !== null) {
      stopManagedFixtureProcess(socketFixture);
      socketFixture = null;
    }
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
    const managedParentTargetText =
      managedTargetReadPath === managedParentTargetConfig
        ? null
        : readRegularFile(managedParentTargetConfig);
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
      managedRaceIterations,
      managedSymlinkTargetExists,
      managedSymlinkTargetText,
      managedTargetReadAccessed,
    };
  } finally {
    if (managedRace !== null) managedRace.child.kill("SIGTERM");
    if (socketFixture !== null) socketFixture.child.kill("SIGTERM");
    targetReadProbe?.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
