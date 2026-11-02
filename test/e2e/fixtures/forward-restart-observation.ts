// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnObservedChild, type ChildProcessProgress } from "./observed-child-process.ts";

export interface ForwardRestartObservation {
  schemaVersion: 1;
  source: "separate-service-forward";
  startedAt: string;
  ready: boolean;
  spawnFailed: boolean;
  exitedBeforeCleanup: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string | null;
  stderrBytes: number;
  stderrTruncated: boolean;
  sandboxNotReady: boolean;
  sandboxMissing: boolean;
  bindFailed: boolean;
  cleanupConfirmed: boolean;
}

async function within(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Observe a separate forward without replacing or recovering the dashboard listener. */
export async function observeForwardRestart<T>(options: {
  progress: ChildProcessProgress;
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  restart: () => Promise<T>;
  record: (observation: ForwardRestartObservation) => Promise<unknown>;
}): Promise<T> {
  const observation: ForwardRestartObservation = {
    schemaVersion: 1,
    source: "separate-service-forward",
    startedAt: new Date().toISOString(),
    ready: false,
    spawnFailed: false,
    exitedBeforeCleanup: false,
    exitCode: null,
    signal: null,
    exitedAt: null,
    stderrBytes: 0,
    stderrTruncated: false,
    sandboxNotReady: false,
    sandboxMissing: false,
    bindFailed: false,
    cleanupConfirmed: false,
  };
  const child = spawnObservedChild(options.executable, options.args, {
    activityLabel: "command: observe-forward-restart",
    progress: options.progress,
    spawn: { env: options.env, shell: false, stdio: ["ignore", "ignore", "pipe"] },
  });
  let settleReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve;
  });
  let settleExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    settleExit = resolve;
  });
  let closed = false;
  let stderrTail = "";
  child.on("error", () => {
    observation.spawnFailed = true;
    settleReady();
  });
  child.once("close", (code, signal) => {
    closed = true;
    observation.exitCode = code;
    observation.signal = signal;
    observation.exitedAt = new Date().toISOString();
    settleReady();
    settleExit();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    observation.stderrBytes += Buffer.byteLength(chunk);
    observation.stderrTruncated ||= observation.stderrBytes > 4096;
    // Keep only a rolling window for split messages. No child text enters artifacts.
    stderrTail = (stderrTail + chunk).slice(-4096).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
    observation.sandboxNotReady ||=
      /is no longer ready \(phase: [A-Za-z]+\); stopping service forward/.test(stderrTail);
    observation.sandboxMissing ||= /no longer exists; stopping service forward/.test(stderrTail);
    observation.bindFailed ||= /failed to bind local forward/.test(stderrTail);
    if (/Forwarding .* -> .* in sandbox .* via gRPC/.test(stderrTail)) {
      observation.ready = true;
      settleReady();
    }
  });
  let outcome: { passed: true; value: T } | { passed: false; error: unknown };
  try {
    await within(ready, 5_000);
    outcome = { passed: true, value: await options.restart() };
  } catch (error) {
    outcome = { passed: false, error };
  }
  observation.exitedBeforeCleanup = closed;
  // Only this child is owned here. Never stop or recover the original dashboard forward.
  if (!closed) {
    child.kill("SIGTERM");
    await within(exited, 2_000);
  }
  if (!closed) {
    child.kill("SIGKILL");
    await within(exited, 2_000);
  }
  observation.cleanupConfirmed = closed;
  child.stderr?.destroy();
  try {
    await options.record(observation);
  } catch {
    // Diagnostic persistence must not replace the restart result or its error.
  }
  if (!outcome.passed) throw outcome.error;
  if (!closed) throw new Error("Could not confirm diagnostic service forward cleanup");
  return outcome.value;
}
