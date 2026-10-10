// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/** Probe process state independently of the production gateway stopper. */
export function isAlive(pid: number): boolean {
  // An exited orphan can retain its PID until init reaps it.
  // The stopper requires every reported Linux thread to be exited.
  // PID existence alone does not prove liveness.
  const args = ["-p", String(pid), "-o", "stat="];
  if (process.platform === "linux") args.push("-L");
  const status = spawnSync("ps", args, { encoding: "utf-8", timeout: 5000 });
  const states = status.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().charAt(0));
  const absent = status.status === 1 && !status.stdout.trim() && !status.stderr.trim();
  const knownStates =
    status.status === 0 && states.every((state) => /^[DIKPRSTUWtZXx]$/.test(state));
  assert.ok(absent || knownStates, "gateway fixture process state could not be inspected");
  // A zombie has exited and released its listener, even before init reaps its PID.
  return !absent && states.some((state) => /^[DIKPRSTUWt]$/.test(state));
}
