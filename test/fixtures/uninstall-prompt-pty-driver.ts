// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Process-level driver for the uninstall confirm-prompt pty tests. Loaded by
// test/uninstall-prompt-pty.test.ts via `tsx <driver>` under `script -qec`
// (a pseudo-TTY), so fd 0 is a real terminal device; not picked up by
// Vitest's discovery (lives under test/fixtures/, which is excluded from the
// test glob).
//
// Why subprocess: #5188 lives at the OS layer — fd 0 flipped non-blocking by
// the `process.stdin` getter (libuv side effect) — which cannot be reproduced
// inside a Vitest worker, whose stdin is a pipe the pool has already touched.
// This driver runs `runUninstallPlan` with its REAL default readLine/isTty
// runtime (the units fixed for #5188) while stubbing every destructive
// dependency to a no-op, so a typed "y" walks the full plan without touching
// the host. Scenario flags:
//   PTY_DRIVER_POISON_STDIN=1  touch `process.stdin` first, flipping fd 0
//                              non-blocking — the exact regression condition.
//   PTY_DRIVER_PRESERVABLE=1   pretend ~/.nemoclaw user data exists so the
//                              second "Also remove them? [y/N]" prompt runs.
//
// Accepts and ignores argv so `bash uninstall.sh` can exec it through its
// NEMOCLAW_NODE/NEMOCLAW_CLI_JS overrides (`internal uninstall run-plan`).
// Refs #5188, #5020, #5163.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type { RunResult } from "../../src/lib/actions/uninstall/run-plan";

// tsx executes this entry as ESM while the CLI sources compile as CommonJS,
// so a static named import cannot see the CJS exports. `createRequire` loads
// the module through tsx's CJS hook instead — same approach as
// strict-tool-call-probe-driver.ts.
const require = createRequire(import.meta.url);
const { runUninstallPlan } =
  require("../../src/lib/actions/uninstall/run-plan") as typeof import("../../src/lib/actions/uninstall/run-plan");

if (process.env.PTY_DRIVER_POISON_STDIN === "1") {
  void process.stdin.isTTY;
}

const preservable = process.env.PTY_DRIVER_PRESERVABLE === "1";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pty-driver-"));
const okResult: RunResult = { status: 0, stdout: "", stderr: "" };

const { exitCode } = runUninstallPlan(
  { assumeYes: false, deleteModels: false, keepOpenShell: true },
  {
    commandExists: () => false,
    // Hermetic env: the runtime merges the real process.env, so a developer
    // shell exporting NEMOCLAW_* knobs (non-interactive mode, destroy-user-
    // data acknowledgement, agent branding) would change which prompts run
    // and what they print. Pin them empty so scenarios behave identically on
    // every machine.
    env: {
      HOME: home,
      NEMOCLAW_AGENT: "",
      NEMOCLAW_NON_INTERACTIVE: "",
      NEMOCLAW_UNINSTALL_DESTROY_USER_DATA: "",
      TMPDIR: home,
    } as NodeJS.ProcessEnv,
    existsSync: (target) => preservable && target.includes(".nemoclaw"),
    kill: () => true,
    rmSync: (() => {}) as never,
    run: () => okResult,
    runDocker: () => okResult,
    // readLine and isTty are deliberately NOT injected: the default
    // readLineFromStdin/isStdinTty pair reading the pty is what is under test.
  },
);
process.exit(exitCode);
