// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnMock.mockImplementation((...args: Parameters<typeof actual.spawn>) => actual.spawn(...args));
  return { ...actual, spawn: spawnMock };
});

import { startTestProgress, type TestProgress } from "../fixtures/progress.ts";
import { driveInteractiveCommand } from "../live/onboard-interactive-pty.ts";

function observedProgress(scenario: string): TestProgress {
  return startTestProgress(scenario, ["drive the child", "observe its result"], {
    logLine: () => undefined,
  });
}

describe("interactive PTY driver", () => {
  it("reports the real exit code when the child exits normally instead of a false timeout", async () => {
    const progress = observedProgress("onboard-interactive-pty clean exit");
    try {
      const result = await driveInteractiveCommand({
        activityLabel: "command: onboard-interactive-pty-clean-exit",
        cmd: ["python3", "-c", "print('hello')"],
        env: process.env,
        progress,
        rules: [],
        timeoutMs: 10_000,
      });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    } finally {
      progress.stop();
    }
  });

  it("matches visible text across ANSI redraw sequences and can send Ctrl+D", async () => {
    const progress = observedProgress("onboard-interactive-pty ANSI trigger");
    try {
      const result = await driveInteractiveCommand({
        activityLabel: "command: onboard-interactive-pty-ansi-trigger",
        cmd: [
          "python3",
          "-c",
          "import sys; sys.stdout.write('NEMOCLAW_PI\\x1b[31m_INTERACTIVE_OK\\x1b[0m\\n'); sys.stdout.flush(); sys.stdin.read()",
        ],
        env: process.env,
        progress,
        rules: [{ trigger: "NEMOCLAW_PI_INTERACTIVE_OK", response: "\u0004" }],
        timeoutMs: 10_000,
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.firedTriggers).toContain("NEMOCLAW_PI_INTERACTIVE_OK");
      expect(result.visibleOutput).toContain("NEMOCLAW_PI_INTERACTIVE_OK");
    } finally {
      progress.stop();
    }
  });

  it("keeps every scripted response, including a secret, out of the spawned process arguments", async () => {
    spawnMock.mockClear();
    const progress = observedProgress("onboard-interactive-pty argv secrecy");
    const secret = "test-secret-abc123";
    try {
      const result = await driveInteractiveCommand({
        activityLabel: "command: onboard-interactive-pty-argv-secret",
        cmd: ["python3", "-c", "import sys; print('prompt:'); sys.stdout.flush(); print(input())"],
        env: process.env,
        progress,
        rules: [{ trigger: "prompt:", response: `${secret}\n` }],
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(0);
      // Confirms the response was actually delivered to the child, not just
      // that it never got sent.
      expect(result.output).toContain(secret);

      const call = spawnMock.mock.calls.at(-1);
      expect(call, "expected driveInteractiveCommand to spawn the driver process").toBeTruthy();
      const [, args] = call as [unknown, readonly string[]];
      expect(args.join(" ")).not.toContain(secret);
    } finally {
      progress.stop();
    }
  });

  it("terminates the driver and its forked PTY child together on timeout", async () => {
    const progress = observedProgress("onboard-interactive-pty timeout cleanup");
    const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pty-timeout-"));
    const pidFile = path.join(pidDir, "child.pid");
    try {
      const result = await driveInteractiveCommand({
        activityLabel: "command: onboard-interactive-pty-timeout-cleanup",
        cmd: [
          "python3",
          "-c",
          "import os, signal, sys, time\nsignal.signal(signal.SIGHUP, signal.SIG_IGN)\nopen(sys.argv[1], 'w').write(str(os.getpid()))\ntime.sleep(30)",
          pidFile,
        ],
        env: process.env,
        progress,
        rules: [],
        timeoutMs: 500,
      });
      expect(result.timedOut).toBe(true);

      // Brief grace period for the OS to finish reaping the killed group.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      progress.stop();
      fs.rmSync(pidDir, { recursive: true, force: true });
    }
  });
});
