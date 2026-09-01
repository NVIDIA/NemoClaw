// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  readRecentShieldsAutoRestore,
  type ShieldsAutoRestoreReadResult,
} from "../../../shields/audit";
import { runSandboxExecChild, type SandboxExecChildOptions, type SpawnLikeResult } from "../exec";
import {
  formatShieldsDownRecoveryCommand,
  normalizeShieldsRelockTimeoutSeconds,
} from "./passthrough-shields-warning";

const CONNECT_SHIELDS_RELOCK_LOOKBACK_MS = 10 * 60 * 1000;
const CONNECT_SHIELDS_RELOCK_POLL_MS = 1000;

type ConnectShieldsRelockNoticeReader = (sandboxName: string) => ShieldsAutoRestoreReadResult;

export interface ConnectShieldsRelockNoticeState {
  readonly lastNotifiedRestoreMs: number;
  readonly sandboxName: string;
  readonly startedAtMs: number;
}

export interface ConnectShieldsRelockWatcher {
  stop(): void;
}

// - The connect child runs `ssh -tt`, which puts this terminal in raw mode. ONLCR is off, so a bare LF staircases (#9710).
// - Raw mode belongs to the child and is not observable here. `process.stderr.isTTY` stands in for it.
// - CR before LF is a no-op on a cooked terminal. This check keeps carriage returns out of a redirected file or pipe.
// - The one-shot `nemoclaw <name> agent` warning prints before dispatch, while the terminal is still cooked.
export function formatConnectShieldsRelockNotice(
  sandboxName: string,
  timeoutSeconds: number | null,
  stderrIsTty: boolean = process.stderr.isTTY === true,
): string {
  const safeTimeout = normalizeShieldsRelockTimeoutSeconds(timeoutSeconds);
  const afterPart = safeTimeout === null ? "" : ` after ${String(safeTimeout)}s`;
  const eol = stderrIsTty ? "\r\n" : "\n";
  return (
    `${eol}  ⚠ Shields auto-relocked${afterPart}. This connected session remains open, but restricted operations may now fail.${eol}` +
    `  Run \`${formatShieldsDownRecoveryCommand(sandboxName, safeTimeout)}\` on the host to lower Shields again.${eol}`
  );
}

export function pollConnectShieldsRelockNotice(
  state: ConnectShieldsRelockNoticeState,
  readRecent: ConnectShieldsRelockNoticeReader = (sandboxName) =>
    readRecentShieldsAutoRestore(sandboxName, CONNECT_SHIELDS_RELOCK_LOOKBACK_MS),
  writeNotice: (value: string) => void = (value) => {
    process.stderr.write(value);
  },
): ConnectShieldsRelockNoticeState {
  const result = readRecent(state.sandboxName);
  if (result.kind !== "event") return state;
  const restoreMs = new Date(result.event.timestamp).getTime();
  if (
    !Number.isFinite(restoreMs) ||
    restoreMs < state.startedAtMs ||
    restoreMs <= state.lastNotifiedRestoreMs
  ) {
    return state;
  }
  writeNotice(formatConnectShieldsRelockNotice(state.sandboxName, result.event.timeoutSeconds));
  return { ...state, lastNotifiedRestoreMs: restoreMs };
}

export function startConnectShieldsRelockWatcher(
  sandboxName: string,
  readRecent: ConnectShieldsRelockNoticeReader = (name) =>
    readRecentShieldsAutoRestore(name, CONNECT_SHIELDS_RELOCK_LOOKBACK_MS),
  writeNotice: (value: string) => void = (value) => {
    process.stderr.write(value);
  },
): ConnectShieldsRelockWatcher | null {
  try {
    const startedAtMs = Date.now();
    let state: ConnectShieldsRelockNoticeState = {
      lastNotifiedRestoreMs: startedAtMs - 1,
      sandboxName,
      startedAtMs,
    };
    const poll = () => {
      try {
        state = pollConnectShieldsRelockNotice(state, readRecent, writeNotice);
      } catch {
        // Audit visibility is advisory. Keep the connected session available.
      }
    };
    poll();
    const timer = setInterval(poll, CONNECT_SHIELDS_RELOCK_POLL_MS);
    timer.unref();
    return {
      stop(): void {
        clearInterval(timer);
      },
    };
  } catch {
    // Advisory visibility must never prevent or terminate a connect session.
    return null;
  }
}

// - Shields relock any sandbox that lowered them, so every connect session needs the warning (#9710).
// - NemoClaw ships openclaw, hermes, and langchain-deepagents-code; each declares shields files.
// - #9508 watched OpenClaw sessions only. That scope came from #9453, not from a runtime limit.
export async function runConnectChildWithShieldsRelockNotice(
  binary: string,
  args: readonly string[],
  options: SandboxExecChildOptions,
  sandboxName: string,
): Promise<SpawnLikeResult> {
  const watcher = startConnectShieldsRelockWatcher(sandboxName);
  try {
    return await runSandboxExecChild(binary, args, options);
  } finally {
    watcher?.stop();
  }
}
