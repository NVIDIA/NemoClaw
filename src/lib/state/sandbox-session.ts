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
import { buildSelectedOpenShellSubprocessEnv } from "../adapters/openshell/command-argv";
import { resolveOpenshell } from "../adapters/openshell/resolve";
import type { OpenShellRuntimeSelection } from "../adapters/openshell/runtime-selection";
import { createOpenshellSandboxIdReader } from "../adapters/openshell/sandbox-identity";
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
 *
 * Input format: one line per process — `<PID> <full command line>` from
 * `ps -axo pid,command`.
 */
export function parseSshProcesses(
  processOutput: string | null | undefined,
  sandboxName: string,
  sandboxId?: string | null,
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
    if (sshHost) {
      sessions.push({ sandboxName, pid, sshHost });
      continue;
    }
    // The proxied form carries no sandbox name, so it is only attributable
    // when the caller resolved the sandbox's durable ID.
    if (idPattern?.test(command) && isInteractiveSshCommand(command)) {
      sessions.push({ sandboxName, pid, sshHost: openshellSandboxSshHost(sandboxName) });
      continue;
    }
    // `connect` may use OpenShell's native TTY exec transport rather than SSH.
    // Require the interactive shell command and exact sandbox name; ordinary
    // exec commands and dashboard forwards must not be reported as sessions.
    if (
      /^(?:\S*\/)?openshell\s+sandbox\s+exec\b/.test(command) &&
      execNamePattern.test(command) &&
      /(?:^|\s)--tty(?:\s|$)/.test(command) &&
      /(?:^|\s)--\s+\/bin\/bash\s+-i(?:\s|$)/.test(command)
    ) {
      sessions.push({ sandboxName, pid, transport: "openshell-exec" });
    }
  }

  return sessions;
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
  const sandboxId = processOutput.includes("--sandbox-id")
    ? (deps.resolveSandboxId?.(sandboxName) ?? null)
    : null;
  const sessions = parseSshProcesses(processOutput, sandboxName, sandboxId);

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
