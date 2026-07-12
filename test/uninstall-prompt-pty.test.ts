// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { execTimeout, testTimeoutOptions } from "./helpers/timeouts";

// Deterministic runtime validation for #5188: the uninstall confirm prompts
// must wait for typed input on a real terminal even when fd 0 is already
// non-blocking (the libuv side effect of touching `process.stdin` that made
// every prompt auto-abort after #5020). Vitest workers cannot reproduce this
// — their stdin is a pipe the pool has already touched — so each case drives
// test/fixtures/uninstall-prompt-pty-driver.ts in a fresh child under
// `script -qec`, which allocates a pseudo-TTY for fd 0. The driver runs the
// real default readLine/isTty runtime with all destructive deps stubbed.
//
// Linux-only: `script -qec` is util-linux; macOS ships BSD script with a
// different CLI. CI runs on Linux. Refs #5188, #5020, #5163.

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const DRIVER = path.join(import.meta.dirname, "fixtures", "uninstall-prompt-pty-driver.ts");
const UNINSTALL_SH = path.join(REPO_ROOT, "uninstall.sh");

const ptySupported =
  process.platform === "linux" &&
  spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

interface PtyRun {
  exited: Promise<number | null>;
  isAlive: () => boolean;
  output: () => string;
  waitForOutput: (text: string) => Promise<void>;
  write: (data: string) => void;
}

function spawnUnderPty(command: string, extraEnv: Record<string, string> = {}): PtyRun {
  const child = spawn("script", ["-qec", command, "/dev/null"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "inherit"],
  });
  // A failed scenario can exit before we write the answer; swallow the EPIPE
  // so the assertion failure (not a crash) reports the problem.
  child.stdin.on("error", () => {});
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    exited,
    isAlive: () => child.exitCode === null,
    output: () => stdout,
    waitForOutput: async (text: string) => {
      const deadline = Date.now() + execTimeout(15_000);
      while (Date.now() < deadline) {
        if (stdout.includes(text)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${JSON.stringify(text)}; output so far:\n${stdout}`);
    },
    write: (data: string) => {
      child.stdin.write(data);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(ptySupported)("uninstall confirm prompts under a pseudo-TTY (#5188)", () => {
  it(
    "waits for a typed y on a poisoned non-blocking fd 0 and proceeds",
    testTimeoutOptions(30_000),
    async () => {
      const pty = spawnUnderPty(`${TSX} ${DRIVER}`, { PTY_DRIVER_POISON_STDIN: "1" });
      await pty.waitForOutput("Proceed? [y/N]");
      await sleep(500);
      // The #5188 regression aborted within ~1ms of printing the prompt; the
      // run must still be alive, blocked on input, half a second later.
      expect(pty.isAlive()).toBe(true);
      pty.write("y\n");
      expect(await pty.exited).toBe(0);
      expect(pty.output()).toContain("Claws retracted. Until next time.");
    },
  );

  it("aborts without running the plan on a typed n", testTimeoutOptions(30_000), async () => {
    const pty = spawnUnderPty(`${TSX} ${DRIVER}`, { PTY_DRIVER_POISON_STDIN: "1" });
    await pty.waitForOutput("Proceed? [y/N]");
    await sleep(500);
    expect(pty.isAlive()).toBe(true);
    pty.write("n\n");
    expect(await pty.exited).toBe(0);
    expect(pty.output()).toContain("Aborted.");
    // No plan step (`[1/6] ...`) may run on the decline path.
    expect(pty.output()).not.toContain("[1/");
  });

  it(
    "waits at the second user-data prompt and keeps data on a typed n",
    testTimeoutOptions(30_000),
    async () => {
      const pty = spawnUnderPty(`${TSX} ${DRIVER}`, {
        PTY_DRIVER_POISON_STDIN: "1",
        PTY_DRIVER_PRESERVABLE: "1",
      });
      await pty.waitForOutput("Proceed? [y/N]");
      await sleep(300);
      pty.write("y\n");
      await pty.waitForOutput("Also remove them? [y/N]");
      await sleep(300);
      expect(pty.isAlive()).toBe(true);
      pty.write("n\n");
      expect(await pty.exited).toBe(0);
      expect(pty.output()).toContain("Keeping user data.");
      expect(pty.output()).toContain("Claws retracted. Until next time.");
    },
  );

  it(
    "reaches a waiting prompt through the bash uninstall.sh wrapper",
    testTimeoutOptions(30_000),
    async () => {
      const pty = spawnUnderPty(`bash ${UNINSTALL_SH}`, {
        NEMOCLAW_CLI_JS: DRIVER,
        NEMOCLAW_NODE: TSX,
      });
      await pty.waitForOutput("Proceed? [y/N]");
      await sleep(500);
      expect(pty.isAlive()).toBe(true);
      pty.write("n\n");
      expect(await pty.exited).toBe(0);
      expect(pty.output()).toContain("Aborted.");
    },
  );
});
