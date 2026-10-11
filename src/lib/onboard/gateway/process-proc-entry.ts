// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

type GatewayProcEntry = "cmdline" | "environ" | "exe";
// Recovery must fail closed instead of making unbounded synchronous proc reads.
const MAX_ZOMBIE_SIBLING_PROBES = 64;
const MAX_PROC_ENTRY_BYTES = 64 * 1024;
// Linux execve permits up to 3/4 of its 8 MiB stack ceiling for argv + environ.
// Gateway launches inherit the host environment, which can exceed 64 KiB.
const MAX_PROC_ENVIRONMENT_BYTES = 6 * 1024 * 1024;

function readBoundedText(file: string, maxBytes = MAX_PROC_ENTRY_BYTES): string | null {
  const fd = fs.openSync(file, "r");
  try {
    let buffer = Buffer.allocUnsafe(4096);
    let length = 0;
    while (length <= maxBytes) {
      if (length === buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, maxBytes + 1));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) return buffer.toString("utf8", 0, length);
      length += count;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readEntry(directory: string, entry: GatewayProcEntry): string | null {
  try {
    return entry === "exe"
      ? fs.realpathSync.native(`${directory}/exe`)
      : readBoundedText(
          `${directory}/${entry}`,
          entry === "environ" ? MAX_PROC_ENVIRONMENT_BYTES : MAX_PROC_ENTRY_BYTES,
        );
  } catch {
    return null;
  }
}

/** Read current gateway identity from the same Linux thread group after leader exit. */
export function readGatewayProcEntry(pid: number, entry: GatewayProcEntry): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const root = `/proc/${String(pid)}`;
  const value = readEntry(root, entry);
  if (value !== null && (entry === "exe" || value.trim() !== "")) return value;
  try {
    if (
      process.platform !== "linux" ||
      !/^State:\s+Z\b/m.test(readBoundedText(`${root}/status`) ?? "")
    ) {
      return value;
    }
    // A thread beneath this task directory belongs to this PID's thread group.
    // Never use an unrelated /proc/<tid> or saved PID marker as identity evidence.
    let scanned = 0;
    // Stream one entry at a time so the probe cap also bounds directory enumeration.
    const taskDirectory = fs.opendirSync(`${root}/task`, { bufferSize: 1 });
    try {
      for (;;) {
        if (scanned >= MAX_ZOMBIE_SIBLING_PROBES) return null;
        const task = taskDirectory.readSync();
        if (task === null) break;
        const tid = task.name;
        if (tid === String(pid)) continue;
        scanned += 1;
        if (!/^[1-9]\d*$/.test(tid)) continue;
        const threadValue = readEntry(`${root}/task/${tid}`, entry);
        if (threadValue !== null && (entry === "exe" || threadValue.trim() !== "")) {
          return threadValue;
        }
      }
    } finally {
      taskDirectory.closeSync();
    }
  } catch {
    // A vanished or unreadable thread group cannot establish process identity.
  }
  return value;
}
