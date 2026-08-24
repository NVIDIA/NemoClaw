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

function formatConnectShieldsRelockNotice(
  sandboxName: string,
  timeoutSeconds: number | null,
): string {
  const safeTimeout = normalizeShieldsRelockTimeoutSeconds(timeoutSeconds);
  const afterPart = safeTimeout === null ? "" : ` after ${String(safeTimeout)}s`;
  return (
    `\n  ⚠ Shields auto-relocked${afterPart}. This connected session remains open, but restricted operations may now fail.\n` +
    `  Run \`${formatShieldsDownRecoveryCommand(sandboxName, safeTimeout)}\` on the host to lower Shields again.\n`
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

export async function runConnectChildWithShieldsRelockNotice(
  binary: string,
  args: readonly string[],
  options: SandboxExecChildOptions,
  sandboxName: string,
  watchShields: boolean,
): Promise<SpawnLikeResult> {
  const watcher = watchShields ? startConnectShieldsRelockWatcher(sandboxName) : null;
  try {
    return await runSandboxExecChild(binary, args, options);
  } finally {
    watcher?.stop();
  }
}
