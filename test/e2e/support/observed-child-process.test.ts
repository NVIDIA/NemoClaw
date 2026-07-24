// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import {
  startTestProgress,
  type TestProgress,
  type TestProgressOptions,
} from "../fixtures/progress.ts";

const progressInstances: TestProgress[] = [];

function trackedProgress(
  scenario: string,
  phasePlan: readonly string[],
  options: TestProgressOptions = {},
): TestProgress {
  const progress = startTestProgress(scenario, phasePlan, options);
  progressInstances.push(progress);
  return progress;
}

function observedProgress(): TestProgress {
  return trackedProgress("observed child support", ["run observed child", "verify observation"], {
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

function lifecycleLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes("child lifecycle"));
}

describe("observed E2E child process", () => {
  afterEach(() => {
    for (const progress of progressInstances.splice(0)) progress.stop();
  });

  test("ties activity completion and timestamp-only output events to the child", async () => {
    const secret = "OBSERVED_CHILD_SECRET";
    const lines: string[] = [];
    const timers: Array<() => void> = [];
    let clockMs = 0;
    const progress = trackedProgress(
      "observed child support",
      ["run observed child", "verify observation"],
      {
        clearTimer: () => undefined,
        logLine: (line) => lines.push(line),
        now: () => clockMs,
        setTimer: (callback, delayMs) => {
          timers.push(() => {
            clockMs += delayMs;
            callback();
          });
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

  test.each([
    ["exited-zero", "process.exit(0)"],
    ["exited-nonzero", "process.exit(7)"],
  ] as const)("classifies a child that terminates as %s", async (outcome, script) => {
    const lines: string[] = [];
    const progress = trackedProgress(
      "observed child classification",
      ["run classified child", "verify child classification"],
      {
        logLine: (line) => lines.push(line),
      },
    );
    const child = spawnObservedChild(process.execPath, ["-e", script], {
      activityLabel: "command: classified-child",
      progress,
      spawn: { stdio: "ignore" },
    });

    await waitForClose(child);
    expect(lifecycleLines(lines)).toEqual([
      expect.stringContaining("child lifecycle 1: started"),
      expect.stringContaining(`child lifecycle 1: ${outcome}`),
    ]);
  });

  test("keeps a post-launch process error distinct from a spawn failure", async () => {
    const secret = "POST_LAUNCH_ERROR_SECRET";
    const lines: string[] = [];
    const progress = trackedProgress(
      "observed child post-launch error",
      ["start launched child", "verify launched child outcome"],
      {
        logLine: (line) => lines.push(line),
      },
    );
    const child = spawnObservedChild(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 100)"],
      {
        activityLabel: "command: launched-child",
        progress,
        spawn: { stdio: "ignore" },
      },
    );
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    child.emit("error", new Error(secret));

    await waitForClose(child);
    const checkpoints = lifecycleLines(lines);
    expect(checkpoints).toEqual([
      expect.stringContaining("child lifecycle 1: started"),
      expect.stringContaining("child lifecycle 1: exited-zero"),
    ]);
    expect(checkpoints.join("\n")).not.toContain(secret);
    expect(checkpoints.join("\n")).not.toContain("spawn-failed");
  });

  test("classifies a child terminated by a signal without exposing that signal", async () => {
    const lines: string[] = [];
    const progress = trackedProgress(
      "observed child signal classification",
      ["start signal-bound child", "verify signal classification"],
      {
        logLine: (line) => lines.push(line),
      },
    );
    const child = spawnObservedChild(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1_000)"],
      {
        activityLabel: "command: signal-bound-child",
        progress,
        spawn: { stdio: "ignore" },
      },
    );
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    child.kill("SIGTERM");

    await waitForClose(child);
    const checkpoints = lifecycleLines(lines);
    expect(checkpoints).toEqual([
      expect.stringContaining("child lifecycle 1: started"),
      expect.stringContaining("child lifecycle 1: signaled"),
    ]);
    expect(checkpoints.join("\n")).not.toContain("SIGTERM");
  });

  test("records one launch failure only after the failed child closes", async () => {
    const lines: string[] = [];
    const progress = trackedProgress(
      "observed child launch failure",
      ["start unavailable child", "verify launch failure"],
      {
        logLine: (line) => lines.push(line),
      },
    );
    const child = spawnObservedChild("nemoclaw-observed-child-missing-binary", [], {
      activityLabel: "command: unavailable-child",
      progress,
      spawn: { stdio: "ignore" },
    });
    const closed = new Promise<void>((resolve) => {
      child.once("error", () => undefined);
      child.once("close", () => resolve());
    });

    expect(lifecycleLines(lines)).toEqual([expect.stringContaining("child lifecycle 1: started")]);
    await closed;
    expect(lifecycleLines(lines)).toEqual([
      expect.stringContaining("child lifecycle 1: started"),
      expect.stringContaining("child lifecycle 1: spawn-failed"),
    ]);
  });

  test("keeps lifecycle checkpoints ordinal, idempotent, frozen, and content-free", async () => {
    const secret = "OBSERVED_CHILD_LIFECYCLE_SECRET";
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `${secret}-`));
    const lines: string[] = [];
    try {
      const progress = trackedProgress(
        "observed child content boundary",
        ["run secret-bearing child", "verify content-free lifecycle"],
        {
          logLine: (line) => lines.push(line),
        },
      );
      const unfinished = progress.beginChildLifecycle();
      expect(Object.isFrozen(unfinished)).toBe(true);
      unfinished("closed-unknown");
      unfinished("exited-zero");

      const child = spawnObservedChild(
        process.execPath,
        [
          "-e",
          "process.stdout.write([process.argv[1], process.env.CHILD_SECRET, process.cwd(), process.pid].join(':'))",
          secret,
        ],
        {
          activityLabel: `command: ${secret}`,
          progress,
          spawn: {
            cwd: workdir,
            env: { ...process.env, CHILD_SECRET: secret },
            stdio: ["ignore", "pipe", "pipe"],
          },
        },
      );
      await waitForClose(child);

      const checkpoints = lifecycleLines(lines);
      expect(checkpoints).toHaveLength(4);
      expect(checkpoints).toEqual([
        expect.stringContaining("child lifecycle 1: started"),
        expect.stringContaining("child lifecycle 1: closed-unknown"),
        expect.stringContaining("child lifecycle 2: started"),
        expect.stringContaining("child lifecycle 2: exited-zero"),
      ]);
      expect(checkpoints.join("\n")).not.toContain(secret);
      expect(checkpoints.join("\n")).not.toMatch(/\bpid\b|command:/iu);
    } finally {
      fs.rmSync(workdir, { force: true, recursive: true });
    }
  });

  test("leaves a durable start checkpoint without inventing a terminal outcome", () => {
    const lines: string[] = [];
    const progress = trackedProgress(
      "observed child interrupted runner",
      ["start interrupted child", "verify interruption evidence"],
      {
        logLine: (line) => lines.push(line),
      },
    );

    progress.beginChildLifecycle();
    progress.stop("failed");

    expect(lifecycleLines(lines)).toEqual([expect.stringContaining("child lifecycle 1: started")]);
  });

  test("keeps process execution independent from rejected lifecycle logging", async () => {
    const progress = trackedProgress(
      "observed child logging failure",
      ["run child with failed logger", "verify child completion"],
      {
        logLine: () => {
          throw new Error("diagnostic logger failed");
        },
      },
    );
    const child = spawnObservedChild(process.execPath, ["-e", "process.exit(0)"], {
      activityLabel: "command: logging-failure-child",
      progress,
      spawn: { stdio: "ignore" },
    });

    await expect(waitForClose(child)).resolves.toEqual({ code: 0, signal: null });
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
    let clockMs = 0;
    const progress = trackedProgress(
      "observed child support",
      ["run observed child", "verify observation"],
      {
        clearTimer: () => undefined,
        logLine: (line) => lines.push(line),
        now: () => clockMs,
        setTimer: (callback, delayMs) => {
          timers.push(() => {
            clockMs += delayMs;
            callback();
          });
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
    expect(lifecycleLines(lines)).toEqual([
      expect.stringContaining("child lifecycle 1: started"),
      expect.stringContaining("child lifecycle 1: spawn-failed"),
    ]);
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
