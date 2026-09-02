// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { isErrnoException } from "../../core/errno";

export interface ProcessIdentityProbes {
  readonly currentPid: number;
  isAlive(pid: number): boolean;
  readStartIdentity(pid: number): string | null;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
}

/**
 * Read a process-start identity as Linux start ticks, with a bounded portable
 * `ps` fallback. Callers compare the opaque identity without wall-clock
 * conversion or timestamp tolerance.
 */
export function readProcessStartIdentity(pid: number, timeoutMs = 5_000): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const statText = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const closeParen = statText.lastIndexOf(")");
    if (closeParen >= 0) {
      const fieldsAfterComm = statText
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      if (fieldsAfterComm[19]) return `proc:${fieldsAfterComm[19]}`;
    }
  } catch {
    // Fall through to the portable ps identity.
  }
  try {
    const timeout = Math.max(1, Math.floor(timeoutMs));
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    })
      .toString()
      .trim();
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

/** Real host probes used when state logic does not inject deterministic evidence. */
export const hostProcessIdentityProbes: ProcessIdentityProbes = {
  currentPid: process.pid,
  isAlive: isProcessAlive,
  readStartIdentity: readProcessStartIdentity,
};
