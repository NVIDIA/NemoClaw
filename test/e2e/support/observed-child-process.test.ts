// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";

import { describe, expect, test } from "vitest";

import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import { startTestProgress, type TestProgress } from "../fixtures/progress.ts";

function observedProgress(): TestProgress {
  return startTestProgress("observed child support", ["run observed child", "verify observation"], {
    logLine: () => undefined,
  });
}

function waitForClose(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

describe("observed E2E child process", () => {
  test("ties activity completion and timestamp-only output events to the child", async () => {
    const secret = "OBSERVED_CHILD_SECRET";
    const lines: string[] = [];
    const timers: Array<() => void> = [];
    const progress = startTestProgress(
      "observed child support",
      ["run observed child", "verify observation"],
      {
        clearTimer: () => undefined,
        logLine: (line) => lines.push(line),
        setTimer: (callback) => {
          timers.push(callback);
          return {};
        },
      },
    );
    const child = spawnObservedChild(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(secret)}); process.stderr.write("err")`],
      {
        activityLabel: "command: observed-child-contract",
        progress,
        spawn: { stdio: ["ignore", "pipe", "pipe"] },
      },
    );

    await expect(waitForClose(child)).resolves.toEqual({ code: 0, signal: null });
    timers[0]?.();
    expect(lines.at(-1)).toContain("no active command");
    progress.stop();
    const phase = progress.summary().phases[0];
    expect(phase?.outputEvents).toBe(2);
    expect(phase?.lastOutputAtMs).toEqual(expect.any(Number));
    expect(JSON.stringify(progress.summary())).not.toContain(secret);
  });

  test("keeps process execution independent from rejected activity diagnostics", async () => {
    const child = spawnObservedChild(process.execPath, ["-e", "process.stdout.write('ok')"], {
      activityLabel: "invalid\nactivity",
      progress: observedProgress(),
      spawn: { stdio: ["ignore", "pipe", "pipe"] },
    });

    await expect(waitForClose(child)).resolves.toEqual({ code: 0, signal: null });
  });

  test("finishes the activity when spawn throws synchronously", () => {
    const lines: string[] = [];
    const timers: Array<() => void> = [];
    const progress = startTestProgress(
      "observed child support",
      ["run observed child", "verify observation"],
      {
        clearTimer: () => undefined,
        logLine: (line) => lines.push(line),
        setTimer: (callback) => {
          timers.push(callback);
          return {};
        },
      },
    );
    expect(() =>
      spawnObservedChild("bad\0command", [], {
        activityLabel: "command: invalid-spawn",
        progress,
        spawn: { stdio: "ignore" },
      }),
    ).toThrow();
    timers[0]?.();
    expect(lines.at(-1)).toContain("no active command");
  });

  test("rejects a derived look-alike that copied the private capability", () => {
    const derived = { ...observedProgress() } as unknown as TestProgress;
    expect(() =>
      spawnObservedChild(process.execPath, ["-e", "process.exit(0)"], {
        activityLabel: "command: derived-progress",
        progress: derived,
        spawn: { stdio: "ignore" },
      }),
    ).toThrow(/canonical E2E progress capability/);
  });
});
