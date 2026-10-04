// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

interface TimerHandle {
  unref?: () => void;
}

export interface ChannelsStopStartProgressOptions {
  heartbeatIntervalMs?: number;
  setTimer?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  logLine?: (line: string) => void;
}

export interface ChannelsStopStartProgress {
  stop: () => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Keep the long channel lifecycle target visible without forwarding captured
 * command output, which may contain credentials.
 */
export function startChannelsStopStartProgress(
  agent: "openclaw" | "hermes",
  options: ChannelsStopStartProgressOptions = {},
): ChannelsStopStartProgress {
  const setTimer =
    options.setTimer ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const logLine = options.logLine ?? ((line) => process.stdout.write(`${line}\n`));
  let stopped = false;

  const timer = setTimer(() => {
    try {
      logLine(`[channels-stop-start] live test still running for ${agent}`);
    } catch {
      // Diagnostics must not change the live test result.
    }
  }, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
    },
  };
}
