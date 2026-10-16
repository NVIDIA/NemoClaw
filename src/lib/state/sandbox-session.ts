// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Active sandbox session detection.
 *
 * Provides typed, testable utilities for detecting active SSH and interactive
 * OpenShell exec connections to sandboxes. Used by destructive operations
 * (destroy, rebuild, stop) to warn users before terminating sessions, and by
 * informational commands (status, list, connect) to show connection state.
 *
 * Design follows gateway-state.ts pattern: pure classifiers that parse
 * CLI output are separated from the I/O layer that invokes those commands.
 */

import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildSelectedOpenShellSubprocessEnv } from "../adapters/openshell/command-argv";
import { resolveOpenshell } from "../adapters/openshell/resolve";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";
import { createOpenshellSandboxIdReader } from "../adapters/openshell/sandbox-identity";
import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import { openshellSandboxSshHost } from "../adapters/openshell/sandbox-ssh-host";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A detected session to a sandbox, over SSH or OpenShell's native exec transport. */
export type SandboxSession =
  | {
      sandboxName: string;
      pid: number;
      /** SSH target host (current `.default` or legacy upgrade-window alias). */
      sshHost: string;
    }
  | {
      sandboxName: string;
      pid: number;
      /** Native OpenShell interactive TTY exec session. */
      transport: "openshell-exec";
    };

/** Result of detecting active sessions for a sandbox. */
export interface ActiveSessionsResult {
  /** Whether detection was able to run (false if tools unavailable). */
  detected: boolean;
  /** Active sessions found for the requested sandbox. */
  sessions: SandboxSession[];
}

// ---------------------------------------------------------------------------
// Pure classifiers — parse CLI output, no I/O
// ---------------------------------------------------------------------------

/**
 * Does this command line belong to an interactive shell rather than a forward?
 *
 * OpenShell starts the dashboard port-forward through the same proxy and the
 * same `sandbox` host alias as `connect`, so the sandbox reference alone cannot
 * tell them apart. The interactive session is the one that asks for a TTY; the
 * forward runs `-N` with no remote command. Counting the forward would report a
 * session on every Ready sandbox.
 */
function isInteractiveSshCommand(command: string): boolean {
  return /(?:^|\s)-tt(?:\s|$)/.test(command) || /RequestTTY=force/.test(command);
}

/**
 * Parse process-list output to find SSH or interactive native exec sessions for a sandbox.
 *
 * SSH detection recognizes multiple shapes. OpenShell used to place the sandbox in the SSH
 * host itself (`openshell-<sandboxName>.default`, and the legacy
 * `openshell-<sandboxName>` from the v0.0.85 to v0.0.99 upgrade window); those
 * are matched as complete tokens so one sandbox name cannot match another it is
 * a prefix of (`dev` vs `dev-staging`). Newer OpenShell connects every sandbox
 * through the fixed `sandbox` alias and identifies the target with
 * `--sandbox-id <id>` on its proxy command instead, which left interactive
 * sessions invisible to every session-reporting surface (#9316). When the
 * caller knows the durable sandbox ID, that form is matched too. Native exec
 * sessions require an exact `--name`, `--tty`, and interactive `/bin/bash -i`.
 * Gateway-scoped native sessions use `-g/--gateway` or the process's
 * `OPENSHELL_GATEWAY`; SSH uses `--gateway-name` or the ProxyCommand in a
 * NemoClaw-owned Hermes ACP temporary config. Missing identity fails closed.
 *
 * Input format: one line per process — `<PID> <full command line>` from
 * `ps -axo pid,command`.
 */
export function parseSshProcesses(
  processOutput: string | null | undefined,
  sandboxName: string,
  sandboxId?: string | null,
  gatewayName?: string | null,
  gatewayEvidence: ReadonlyMap<number, string> = new Map(),
): SandboxSession[] {
  if (!processOutput || typeof processOutput !== "string") return [];
  if (!sandboxName) return [];

  const sshHosts = [openshellSandboxSshHost(sandboxName), `openshell-${sandboxName}`] as const;
  const hostPatterns = sshHosts.map(
    (sshHost) => [sshHost, new RegExp(`(?:^|\\s)${escapeRegExp(sshHost)}(?:\\s|$)`)] as const,
  );
  const idPattern =
    sandboxId && sandboxId.trim()
      ? new RegExp(`--sandbox-id[=\\s]+${escapeRegExp(sandboxId.trim())}(?:\\s|$)`)
      : null;
  const execNamePattern = new RegExp(`--name(?:=|\\s+)${escapeRegExp(sandboxName)}(?:\\s|$)`);
  const sessions: SandboxSession[] = [];
  const lines = processOutput.split("\n").filter(Boolean);

  for (const line of lines) {
    const pidMatch = line.match(/^\s*(\d+)\s+(.+)/);
    if (!pidMatch) continue;

    const pid = Number.parseInt(pidMatch[1], 10);
    const command = pidMatch[2];

    const sshHost = hostPatterns.find(([, pattern]) => pattern.test(command))?.[0];
    if (sshHost && matchesSshGateway(command, gatewayName, gatewayEvidence.get(pid))) {
      sessions.push({ sandboxName, pid, sshHost });
      continue;
    }
    // The proxied form carries no sandbox name, so it is only attributable
    // when the caller resolved the sandbox's durable ID.
    if (
      idPattern?.test(command) &&
      isInteractiveSshCommand(command) &&
      matchesSshGateway(command, gatewayName, gatewayEvidence.get(pid))
    ) {
      sessions.push({ sandboxName, pid, sshHost: openshellSandboxSshHost(sandboxName) });
      continue;
    }
    // `connect` may use OpenShell's native TTY exec transport rather than SSH.
    // Require the interactive shell command and exact sandbox name; ordinary
    // exec commands and dashboard forwards must not be reported as sessions.
    if (
      /^(?:\S*\/)?openshell\s+sandbox\s+exec\b/.test(command) &&
      execNamePattern.test(command) &&
      matchesNativeExecGateway(command, gatewayName, gatewayEvidence.get(pid)) &&
      /(?:^|\s)--tty(?:\s|$)/.test(command) &&
      /(?:^|\s)--\s+\/bin\/bash\s+-i(?:\s|$)/.test(command)
    ) {
      sessions.push({ sandboxName, pid, transport: "openshell-exec" });
    }
  }

  return sessions;
}

/** Match one gateway selector before `--`; multiple selectors fail closed. */
function matchesNativeExecGateway(
  command: string,
  gatewayName?: string | null,
  resolvedGateway?: string,
): boolean {
  const cliArguments = command.split(/\s--\s/, 1)[0] ?? command;
  const selectors = nativeGatewaySelectors(cliArguments);
  if (selectors.length > 1) return false;
  const actualGateway = selectors[0] ?? resolvedGateway;
  const expectedGateway = gatewayName?.trim();
  return !expectedGateway || (actualGateway !== undefined && actualGateway === expectedGateway);
}

/** Match one SSH gateway selector or resolved config identity; multiples fail closed. */
function matchesSshGateway(
  command: string,
  gatewayName?: string | null,
  resolvedGateway?: string,
): boolean {
  const cliArguments = command.split(/\s--\s/, 1)[0] ?? command;
  const selectors = sshGatewaySelectors(cliArguments);
  if (selectors.length > 1) return false;
  const actualGateway = selectors[0] ?? resolvedGateway;
  const expectedGateway = gatewayName?.trim();
  return !expectedGateway || (actualGateway !== undefined && actualGateway === expectedGateway);
}

function nativeGatewaySelectors(command: string): string[] {
  return [...command.matchAll(/(?:^|\s)(?:-g|--gateway)(?:=|\s+)([^\s]+)/g)].map(
    (match) => match[1]!,
  );
}

function sshGatewaySelectors(command: string): string[] {
  return [...command.matchAll(/(?:^|\s)--gateway-name(?:=|\s+)["']?([^\s"']+)['"]?/g)].map(
    (match) => match[1]!,
  );
}

/** Escape special regex characters in a string for safe use in RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// I/O layer — invokes system commands to gather raw output
// ---------------------------------------------------------------------------

export interface SessionDetectionDeps {
  /** Return candidate SSH and OpenShell exec process lines. Null if unavailable. */
  getSshProcesses: () => string | null;
  /**
   * Resolve the sandbox's durable OpenShell ID, or null when it cannot be
   * determined. Only consulted when the process list contains a proxied
   * connection, which is the only shape that needs it (#9316).
   */
  resolveSandboxId?: (sandboxName: string) => string | null;
  /** Return only OPENSHELL_GATEWAY for the matching PID/command, or null if unavailable. */
  resolveNativeExecGateway?: (pid: number, processCommand: string) => string | null;
  /** Return only the gateway from a NemoClaw-owned ACP SSH config, or null. */
  resolveSshConfigGateway?: (processLine: string) => string | null;
}

/**
 * Detect active SSH or interactive OpenShell exec sessions for a named sandbox.
 *
 * This is the high-level entry point used by consumers (destroy, rebuild, etc.).
 * It invokes system commands through the deps interface for testability.
 * Process lines are collected with `ps` so both SSH and native exec transports
 * can be attributed to their target sandbox.
 */
export function getActiveSandboxSessions(
  sandboxName: string,
  deps: SessionDetectionDeps,
  gatewayName?: string | null,
): ActiveSessionsResult {
  if (!sandboxName) {
    return { detected: false, sessions: [] };
  }

  const processOutput = deps.getSshProcesses();

  if (processOutput === null) {
    return { detected: false, sessions: [] };
  }

  // Resolving the ID costs an OpenShell call, so only pay it for the proxied
  // shape that cannot be attributed from the SSH host alone (#9316).
  const processLines = processOutput.split("\n");
  const needsSandboxId = processLines.some((line) => {
    const command = line.replace(/^\s*\d+\s+/, "");
    return (
      /\bssh\b/.test(command) &&
      /--sandbox-id(?:=|\s+)/.test(command) &&
      isInteractiveSshCommand(command)
    );
  });
  const sandboxId = needsSandboxId ? (deps.resolveSandboxId?.(sandboxName) ?? null) : null;
  const gatewayEvidence = new Map<number, string>();
  if (gatewayName?.trim()) {
    const sandboxHosts = [openshellSandboxSshHost(sandboxName), `openshell-${sandboxName}`];
    const hostPatterns = sandboxHosts.map(
      (host) => new RegExp(`(?:^|\\s)${escapeRegExp(host)}(?:\\s|$)`),
    );
    const targetIdPattern = sandboxId
      ? new RegExp(`--sandbox-id[=\\s]+${escapeRegExp(sandboxId)}(?:\\s|$)`)
      : null;
    for (const line of processLines) {
      const pidMatch = line.match(/^\s*(\d+)\s+/);
      if (!pidMatch) continue;
      const pid = Number(pidMatch[1]);
      const command = line.slice(pidMatch[0].length);
      let resolvedGateway: string | null = null;
      if (
        /^(?:\S*\/)?openshell\s+sandbox\s+exec\b/.test(command) &&
        new RegExp(`--name(?:=|\\s+)${escapeRegExp(sandboxName)}(?:\\s|$)`).test(command) &&
        /(?:^|\s)--tty(?:\s|$)/.test(command) &&
        /(?:^|\s)--\s+\/bin\/bash\s+-i(?:\s|$)/.test(command) &&
        nativeGatewaySelectors(command.split(/\s--\s/, 1)[0] ?? command).length === 0
      ) {
        resolvedGateway = deps.resolveNativeExecGateway?.(pid, command) ?? null;
      } else if (
        /\bssh\b/.test(command) &&
        sshGatewaySelectors(command.split(/\s--\s/, 1)[0] ?? command).length === 0 &&
        (hostPatterns.some((pattern) => pattern.test(command)) ||
          (targetIdPattern?.test(command) === true && isInteractiveSshCommand(command)))
      ) {
        resolvedGateway = deps.resolveSshConfigGateway?.(line) ?? null;
      }
      if (resolvedGateway) gatewayEvidence.set(pid, resolvedGateway);
    }
  }
  const sessions = parseSshProcesses(
    processOutput,
    sandboxName,
    sandboxId,
    gatewayName,
    gatewayEvidence,
  );

  return {
    detected: true,
    sessions,
  };
}

/**
 * Query candidate session processes using `ps` (portable across macOS and Linux).
 *
 * `pgrep -a` on macOS only prints PIDs (no command line), making it useless
 * for matching session targets. `ps -axo pid,command` works on both platforms
 * and returns full command lines in a simple `PID COMMAND` format.
 */
function queryCandidateSessionProcesses(runCommand: typeof spawnSync = spawnSync): string | null {
  try {
    const result = runCommand("ps", ["-axo", "pid,command"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    if (result.status !== 0) return null;
    // Keep SSH transports and native OpenShell exec connects; the parser applies
    // the stricter target and interactivity checks for each shape.
    const lines = (result.stdout || "")
      .split("\n")
      .filter((line) => /\bssh\b|(?:^|\s)(?:\S*\/)?openshell\s+sandbox\s+exec\b/.test(line))
      .join("\n");
    return lines;
  } catch {
    return null;
  }
}

/**
 * Create the default system deps for session detection.
 * Uses `ps` on the host.
 */
function readNativeExecGateway(pid: number, expectedCommand: string): string | null {
  if (process.platform !== "linux") return null;

  const maxCommandBytes = 64 * 1024;
  const maxEnvironmentBytes = 4 * 1024 * 1024;
  const maxGatewayBytes = 1024;
  const key = Buffer.from("OPENSHELL_GATEWAY=");
  const commandBuffer = Buffer.alloc(maxCommandBytes);
  const chunk = Buffer.alloc(4096);
  const gateway = Buffer.alloc(maxGatewayBytes);
  let processDirectoryFd: number | undefined;
  let commandFd: number | undefined;
  let environmentFd: number | undefined;
  let bytesRead = 0;
  let entryOffset = 0;
  let matchesKey = true;
  let readingValue = false;
  let gatewayLength = 0;

  try {
    // Pin the proc directory, then verify its cmdline against the earlier ps
    // snapshot before reading environ. This fails closed if the PID was reused.
    processDirectoryFd = openSync(
      `/proc/${String(pid)}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!fstatSync(processDirectoryFd).isDirectory()) return null;

    commandFd = openSync(
      `/proc/self/fd/${String(processDirectoryFd)}/cmdline`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let commandLength = 0;
    while (commandLength < commandBuffer.length) {
      const count = readSync(
        commandFd,
        commandBuffer,
        commandLength,
        commandBuffer.length - commandLength,
        null,
      );
      if (count === 0) break;
      commandLength += count;
    }
    if (commandLength === commandBuffer.length) return null;
    const actualCommand = commandBuffer
      .subarray(0, commandLength)
      .toString("utf8")
      .replace(/\0+$/, "")
      .replaceAll("\0", " ");
    if (actualCommand !== expectedCommand) return null;
    closeSync(commandFd);
    commandFd = undefined;

    environmentFd = openSync(
      `/proc/self/fd/${String(processDirectoryFd)}/environ`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    while (bytesRead < maxEnvironmentBytes) {
      const count = readSync(
        environmentFd,
        chunk,
        0,
        Math.min(chunk.length, maxEnvironmentBytes - bytesRead),
        null,
      );
      if (count === 0) break;
      bytesRead += count;

      for (let index = 0; index < count; index += 1) {
        const byte = chunk[index]!;
        if (byte === 0) {
          if (readingValue) {
            return gatewayLength > 0
              ? gateway.subarray(0, gatewayLength).toString("utf8").trim() || null
              : null;
          }
          entryOffset = 0;
          matchesKey = true;
          readingValue = false;
          gatewayLength = 0;
          continue;
        }

        if (entryOffset < key.length) {
          if (matchesKey && byte === key[entryOffset]) {
            entryOffset += 1;
            if (entryOffset === key.length) readingValue = true;
          } else {
            matchesKey = false;
            entryOffset += 1;
          }
          continue;
        }

        if (readingValue) {
          if (gatewayLength === gateway.length) return null;
          gateway[gatewayLength] = byte;
          gatewayLength += 1;
        }
      }
    }
  } catch {
    return null;
  } finally {
    if (environmentFd !== undefined) closeSync(environmentFd);
    if (commandFd !== undefined) closeSync(commandFd);
    if (processDirectoryFd !== undefined) closeSync(processDirectoryFd);
  }

  return null;
}

function readNemoClawAcpSshGateway(processLine: string): string | null {
  const command = processLine.replace(/^\s*\d+\s+/, "");
  const configMatch = command.match(/(?:^|\s)-F(?:\s+|=)([^\s]+)/);
  const rawConfigPath = configMatch?.[1]?.replace(/^['"]|['"]$/g, "");
  if (!rawConfigPath || process.getuid === undefined) return null;

  const configPath = resolve(rawConfigPath);
  const configDirectory = dirname(configPath);
  if (
    basename(configPath) !== "ssh_config" ||
    dirname(configDirectory) !== resolve(tmpdir()) ||
    !basename(configDirectory).startsWith("nemoclaw-acp-ssh-")
  ) {
    return null;
  }
  if (constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined) return null;

  let directoryFd: number | undefined;
  let configFile: ReturnType<typeof openRegularFileNoFollow> | undefined;
  try {
    directoryFd = openSync(
      configDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const directoryStats = fstatSync(directoryFd);
    const pathStats = lstatSync(configDirectory);
    if (
      !directoryStats.isDirectory() ||
      pathStats.isSymbolicLink() ||
      !pathStats.isDirectory() ||
      directoryStats.uid !== process.getuid() ||
      (directoryStats.mode & 0o077) !== 0 ||
      (directoryStats.mode & 0o700) !== 0o700 ||
      directoryStats.dev !== pathStats.dev ||
      directoryStats.ino !== pathStats.ino
    ) {
      return null;
    }

    const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    configFile = openRegularFileNoFollow(`${descriptorRoot}/${String(directoryFd)}/ssh_config`);
    const fileStats = configFile.stat();
    if (
      fileStats.uid !== process.getuid() ||
      (fileStats.mode & 0o077) !== 0 ||
      (fileStats.mode & 0o400) !== 0o400
    ) {
      return null;
    }
    const config = configFile.readBytes(1_048_576).toString("utf8");
    const currentDirectoryStats = lstatSync(configDirectory);
    if (
      currentDirectoryStats.isSymbolicLink() ||
      currentDirectoryStats.dev !== directoryStats.dev ||
      currentDirectoryStats.ino !== directoryStats.ino ||
      currentDirectoryStats.uid !== directoryStats.uid ||
      currentDirectoryStats.mode !== directoryStats.mode
    ) {
      return null;
    }
    const proxyCommands = config.split("\n").filter((line) => /^\s*ProxyCommand\s+/i.test(line));
    const names = proxyCommands.flatMap((line) =>
      [...line.matchAll(/--gateway-name(?:=|\s+)["']?([^\s"']+)['"]?/g)].map((match) => match[1]!),
    );
    return names.length === 1 ? names[0]! : null;
  } catch {
    return null;
  } finally {
    configFile?.close();
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}

export function createSystemDeps(
  openshellBinary: string | null = resolveOpenshell(),
  options: {
    readonly runtimeSelection?: OpenShellRuntimeSelection;
    readonly spawnSync?: typeof spawnSync;
  } = {},
): SessionDetectionDeps {
  const runCommand = options.spawnSync ?? spawnSync;
  const selectedEnv = options.runtimeSelection
    ? buildSelectedOpenShellSubprocessEnv(options.runtimeSelection)
    : undefined;
  return {
    getSshProcesses: () => queryCandidateSessionProcesses(runCommand),
    resolveNativeExecGateway: readNativeExecGateway,
    resolveSshConfigGateway: readNemoClawAcpSshGateway,
    ...(openshellBinary
      ? {
          resolveSandboxId: createOpenshellSandboxIdReader(openshellBinary, (binary, args) => {
            const selectedArgs = options.runtimeSelection
              ? [args[0]!, args[1]!, "-g", options.runtimeSelection.gatewayName, ...args.slice(2)]
              : args;
            const result = runCommand(binary, selectedArgs, {
              encoding: "utf-8",
              ...(selectedEnv ? { env: selectedEnv } : {}),
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 5000,
            });
            return { status: result.status, stdout: result.stdout || "" };
          }),
        }
      : {}),
  };
}
