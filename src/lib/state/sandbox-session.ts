// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Active sandbox session detection.
 *
 * Provides typed, testable utilities for detecting active SSH connections
 * to OpenShell sandboxes. Used by destructive operations (destroy, rebuild,
 * stop) to warn users before terminating sessions, and by informational
 * commands (status, list, connect) to show connection state.
 *
 * Design follows gateway-state.ts pattern: pure classifiers that parse
 * CLI output are separated from the I/O layer that invokes those commands.
 */

import { spawnSync } from "node:child_process";
import { createOpenshellSandboxIdReader } from "../adapters/openshell/sandbox-identity";
import { openshellSandboxSshHost } from "../adapters/openshell/sandbox-ssh-host";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single detected SSH session to a sandbox. */
export interface SandboxSession {
  /** The sandbox name this session connects to. */
  sandboxName: string;
  /** PID of the SSH process on the host. */
  pid: number;
  /** SSH target host (current `.default` or legacy upgrade-window alias). */
  sshHost: string;
}

/** Result of detecting active sessions for a sandbox. */
export interface ActiveSessionsResult {
  /** Whether detection was able to run (false if tools unavailable). */
  detected: boolean;
  /** Active sessions found for the requested sandbox. */
  sessions: SandboxSession[];
}

/** A forward entry parsed from `openshell forward list` output. */
export interface ForwardEntry {
  /** Sandbox name owning the forward. */
  sandboxName: string;
  /** Bind address (e.g., "127.0.0.1"). */
  bind: string;
  /** Port number being forwarded. */
  port: string;
  /** PID of the forwarding process (null if not parseable). */
  pid: number | null;
  /** Status string (e.g., "running", "stopped"). */
  status: string;
}

// ---------------------------------------------------------------------------
// Pure classifiers — parse CLI output, no I/O
// ---------------------------------------------------------------------------

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Parse `openshell forward list` output into structured forward entries.
 *
 * Output format (columns separated by whitespace):
 *   SANDBOX  BIND  PORT  PID  STATUS
 *
 * The first line may be a header row — we skip lines where "SANDBOX" appears
 * literally in the first column.
 */
export function parseForwardList(output: string | null | undefined): ForwardEntry[] {
  if (!output || typeof output !== "string") return [];

  const entries: ForwardEntry[] = [];
  const lines = stripAnsi(output)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Skip header row
    if (/^\s*SANDBOX\s/i.test(line)) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;

    const [sandboxName, bind, port, pidStr, ...rest] = parts;
    const pid = /^\d+$/.test(pidStr) ? Number.parseInt(pidStr, 10) : null;
    const status = rest.join(" ").toLowerCase() || "unknown";

    entries.push({ sandboxName, bind, port, pid, status });
  }

  return entries;
}

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
 * Parse process list output to find SSH processes targeting a specific sandbox.
 *
 * Two shapes are recognized. OpenShell used to place the sandbox in the SSH
 * host itself (`openshell-<sandboxName>.default`, and the legacy
 * `openshell-<sandboxName>` from the v0.0.85 to v0.0.99 upgrade window); those
 * are matched as complete tokens so one sandbox name cannot match another it is
 * a prefix of (`dev` vs `dev-staging`). Newer OpenShell connects every sandbox
 * through the fixed `sandbox` alias and identifies the target with
 * `--sandbox-id <id>` on its proxy command instead, which left interactive
 * sessions invisible to every session-reporting surface (#9316). When the
 * caller knows the durable sandbox ID, that form is matched too.
 *
 * Input format: one line per process — `<PID> <full command line>`
 * (compatible with both `pgrep -a` on Linux and `ps -axo pid,command`)
 */
export function parseSshProcesses(
  pgrepOutput: string | null | undefined,
  sandboxName: string,
  sandboxId?: string | null,
): SandboxSession[] {
  if (!pgrepOutput || typeof pgrepOutput !== "string") return [];
  if (!sandboxName) return [];

  const sshHosts = [openshellSandboxSshHost(sandboxName), `openshell-${sandboxName}`] as const;
  const hostPatterns = sshHosts.map(
    (sshHost) => [sshHost, new RegExp(`(?:^|\\s)${escapeRegExp(sshHost)}(?:\\s|$)`)] as const,
  );
  const idPattern =
    sandboxId && sandboxId.trim()
      ? new RegExp(`--sandbox-id[=\\s]+${escapeRegExp(sandboxId.trim())}(?:\\s|$)`)
      : null;
  const sessions: SandboxSession[] = [];
  const lines = pgrepOutput.split("\n").filter(Boolean);

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
    }
  }

  return sessions;
}

/** Escape special regex characters in a string for safe use in RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a sandbox has active forwards from parsed forward entries.
 * Active forwards (status includes "running") indicate an active connection.
 */
export function hasActiveForwards(entries: ForwardEntry[], sandboxName: string): boolean {
  return entries.some((e) => e.sandboxName === sandboxName && e.status.includes("running"));
}

/**
 * Get forward entries for a specific sandbox.
 */
export function getForwardsForSandbox(
  entries: ForwardEntry[],
  sandboxName: string,
): ForwardEntry[] {
  return entries.filter((e) => e.sandboxName === sandboxName);
}

/** Classification result from combining forward and SSH session evidence. */
export interface SessionClassification {
  /** Whether interactive SSH sessions are active (authoritative indicator). */
  hasActiveSessions: boolean;
  /** Number of active SSH sessions. */
  sessionCount: number;
  /** Number of running port forwards for this sandbox. */
  forwardCount: number;
  /** Which detection sources contributed evidence (e.g., ["forward", "ssh"]). */
  sources: string[];
}

/**
 * Determine whether there are active SSH sessions for a sandbox from both
 * forward list and process detection.
 *
 * Combines evidence from forward entries and SSH processes. Either source
 * alone is sufficient to detect an active session — forwards may exist
 * without an interactive SSH session (e.g., port-forward only), and SSH
 * sessions may exist without a tracked forward (e.g., manual SSH).
 */
export function classifySessionState(
  forwardEntries: ForwardEntry[],
  sshSessions: SandboxSession[],
  sandboxName: string,
): SessionClassification {
  const sources: string[] = [];

  const activeForwards = getForwardsForSandbox(forwardEntries, sandboxName).filter((e) =>
    e.status.includes("running"),
  );
  if (activeForwards.length > 0) {
    sources.push("forward");
  }

  const matchingSessions = sshSessions.filter((s) => s.sandboxName === sandboxName);
  if (matchingSessions.length > 0) {
    sources.push("ssh");
  }

  // SSH sessions are the authoritative indicator of interactive connections.
  // Forwards alone don't necessarily mean interactive use (dashboard forward).
  const sessionCount = matchingSessions.length;
  const hasActiveSessions = sessionCount > 0;

  return { hasActiveSessions, sessionCount, forwardCount: activeForwards.length, sources };
}

// ---------------------------------------------------------------------------
// I/O layer — invokes system commands to gather raw output
// ---------------------------------------------------------------------------

export interface SessionDetectionDeps {
  /** Run `openshell forward list` and return stdout. Null if unavailable. */
  getForwardList: () => string | null;
  /** Run `pgrep -a ssh` and return stdout. Null if unavailable. */
  getSshProcesses: () => string | null;
  /**
   * Resolve the sandbox's durable OpenShell ID, or null when it cannot be
   * determined. Only consulted when the process list contains a proxied
   * connection, which is the only shape that needs it (#9316).
   */
  resolveSandboxId?: (sandboxName: string) => string | null;
}

/**
 * Detect active SSH sessions for a named sandbox.
 *
 * This is the high-level entry point used by consumers (destroy, rebuild, etc.).
 * It invokes system commands through the deps interface for testability.
 *
 * Detection relies on `pgrep -a ssh` to find SSH processes targeting the
 * sandbox's SSH host. The `getForwardList` dep is not used here (forward
 * activity alone doesn't indicate interactive sessions — the dashboard
 * forward is always running). Consumers that need forward state can call
 * `parseForwardList` + `classifySessionState` directly.
 */
export function getActiveSandboxSessions(
  sandboxName: string,
  deps: SessionDetectionDeps,
): ActiveSessionsResult {
  if (!sandboxName) {
    return { detected: false, sessions: [] };
  }

  const pgrepOutput = deps.getSshProcesses();

  if (pgrepOutput === null) {
    return { detected: false, sessions: [] };
  }

  // Resolving the ID costs an OpenShell call, so only pay it for the proxied
  // shape that cannot be attributed from the SSH host alone (#9316).
  const sandboxId = pgrepOutput.includes("--sandbox-id")
    ? (deps.resolveSandboxId?.(sandboxName) ?? null)
    : null;
  const sshSessions = parseSshProcesses(pgrepOutput, sandboxName, sandboxId);

  return {
    detected: true,
    sessions: sshSessions,
  };
}

/**
 * Query SSH processes using `ps` (portable across macOS and Linux).
 *
 * `pgrep -a` on macOS only prints PIDs (no command line), making it useless
 * for matching SSH target hosts. `ps -axo pid,command` works on both platforms
 * and returns full command lines in pgrep-compatible format (`PID COMMAND`).
 */
function querySshProcesses(): string | null {
  try {
    const result = spawnSync("ps", ["-axo", "pid,command"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    if (result.status !== 0) return null;
    // Filter to only SSH lines to reduce noise and match pgrep -a output format
    const lines = (result.stdout || "")
      .split("\n")
      .filter((line) => /\bssh\b/.test(line))
      .join("\n");
    return lines;
  } catch {
    return null;
  }
}

/**
 * Create the default system deps for session detection.
 * Uses `openshell forward list` and `ps` (cross-platform) on the host.
 */
export function createSystemDeps(openshellBinary: string): SessionDetectionDeps {
  return {
    getForwardList: (): string | null => {
      try {
        const result = spawnSync(openshellBinary, ["forward", "list"], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000,
        });
        if (result.status !== 0) return null;
        return result.stdout || "";
      } catch {
        return null;
      }
    },
    getSshProcesses: querySshProcesses,
    resolveSandboxId: createOpenshellSandboxIdReader(openshellBinary, (binary, args) => {
      const result = spawnSync(binary, args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      });
      return { status: result.status, stdout: result.stdout || "" };
    }),
  };
}
