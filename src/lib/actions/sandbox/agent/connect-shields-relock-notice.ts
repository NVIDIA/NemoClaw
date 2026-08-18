// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeSync } from "node:fs";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import {
  readRecentShieldsAutoRestore,
  type ShieldsAutoRestoreReadResult,
} from "../../../shields/audit";
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
    writeSync(2, value);
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
): ConnectShieldsRelockWatcher | null {
  try {
    const worker = new Worker(__filename, {
      workerData: { sandboxName, startedAtMs: Date.now() },
    });
    worker.on("error", () => undefined);
    worker.unref();
    return {
      stop(): void {
        void worker.terminate().catch(() => undefined);
      },
    };
  } catch {
    // Advisory visibility must never prevent or terminate a connect session.
    return null;
  }
}

function runConnectShieldsRelockWatcher(): void {
  const data = workerData as { sandboxName?: unknown; startedAtMs?: unknown };
  if (
    typeof data.sandboxName !== "string" ||
    data.sandboxName.length < 1 ||
    data.sandboxName.length > 255 ||
    /[\0\r\n]/u.test(data.sandboxName) ||
    typeof data.startedAtMs !== "number" ||
    !Number.isFinite(data.startedAtMs)
  ) {
    return;
  }
  let state: ConnectShieldsRelockNoticeState = {
    lastNotifiedRestoreMs: data.startedAtMs - 1,
    sandboxName: data.sandboxName,
    startedAtMs: data.startedAtMs,
  };
  const poll = () => {
    try {
      state = pollConnectShieldsRelockNotice(state);
    } catch {
      // Audit visibility is advisory. Keep the connected session available.
    }
  };
  poll();
  setInterval(poll, CONNECT_SHIELDS_RELOCK_POLL_MS);
}

if (!isMainThread) runConnectShieldsRelockWatcher();
