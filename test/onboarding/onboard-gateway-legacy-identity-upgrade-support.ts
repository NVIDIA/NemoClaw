// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

/** Probe process state independently of the production gateway stopper. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // An exited orphan can retain its PID until init reaps it. The stopper
  // considers zombie processes exited; PID existence alone is not liveness.
  const args = ["-p", String(pid), "-o", "stat="];
  if (process.platform === "linux") args.push("-L");
  const status = spawnSync("ps", args, { encoding: "utf-8" });
  if (status.status === 1 && status.stdout.trim() === "" && status.stderr.trim() === "") {
    return false;
  }
  // An unreadable status must not turn a still-existing process into a pass.
  return (
    status.status !== 0 ||
    !status.stdout
      .trim()
      .split(/\r?\n/)
      .every((line) => /^[ZXx]/.test(line.trim()))
  );
}
