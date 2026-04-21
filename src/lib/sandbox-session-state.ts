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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single detected SSH session to a sandbox. */
export interface SandboxSession {
  /** The sandbox name this session connects to. */
  sandboxName: string;
  /** PID of the SSH process on the host. */
  pid: number;
  /** SSH target host (typically openshell-<sandboxName>). */
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

/**
 * Parse `openshell forward list` output into structured forward entries.
 *
 * Output format (columns separated by whitespace):
 *   SANDBOX  BIND  PORT  PID  STATUS
 *
 * The first line may be a header row — we skip lines where "SANDBOX" appears
 * literally in the first column.
 */
export function parseForwardList(output: string): ForwardEntry[] {
  if (!output || typeof output !== "string") return [];

  const entries: ForwardEntry[] = [];
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);

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
 * Parse process list output to find SSH processes targeting a specific sandbox.
 *
 * SSH connections to sandboxes use the host pattern `openshell-<sandboxName>`.
 * We match the full SSH host as a complete word to avoid false positives when
 * one sandbox name is a prefix of another (e.g., `dev` vs `dev-staging`).
 *
 * Input format: one line per process — `<PID> <full command line>`
 * (compatible with both `pgrep -a` on Linux and `ps -axo pid,command`)
 */
export function parseSshProcesses(pgrepOutput: string, sandboxName: string): SandboxSession[] {
  if (!pgrepOutput || typeof pgrepOutput !== "string") return [];
  if (!sandboxName) return [];

  const sshHost = `openshell-${sandboxName}`;
  // Match sshHost as a complete word — preceded by whitespace/start and followed
  // by whitespace/end. This prevents `openshell-dev` from matching inside
  // `openshell-dev-staging`.
  const hostPattern = new RegExp(`(?:^|\\s)${escapeRegExp(sshHost)}(?:\\s|$)`);
  const sessions: SandboxSession[] = [];
  const lines = pgrepOutput.split("\n").filter(Boolean);

  for (const line of lines) {
    const pidMatch = line.match(/^\s*(\d+)\s+(.+)/);
    if (!pidMatch) continue;

    const pid = Number.parseInt(pidMatch[1], 10);
    const cmdline = pidMatch[2];

    if (hostPattern.test(cmdline)) {
      sessions.push({ sandboxName, pid, sshHost });
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
  return entries.some(
    (e) => e.sandboxName === sandboxName && e.status.includes("running"),
  );
}

/**
 * Get forward entries for a specific sandbox.
 */
export function getForwardsForSandbox(entries: ForwardEntry[], sandboxName: string): ForwardEntry[] {
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

  const activeForwards = getForwardsForSandbox(forwardEntries, sandboxName).filter(
    (e) => e.status.includes("running"),
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

  const sshSessions = parseSshProcesses(pgrepOutput, sandboxName);

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
  };
}
