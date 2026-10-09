// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

type GatewayProcEntry = "cmdline" | "environ" | "exe";

function readEntry(directory: string, entry: GatewayProcEntry): string | null {
  try {
    return entry === "exe"
      ? fs.realpathSync.native(`${directory}/exe`)
      : fs.readFileSync(`${directory}/${entry}`, "utf8");
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
      !/^State:\s+Z\b/m.test(fs.readFileSync(`${root}/status`, "utf8"))
    ) {
      return value;
    }
    // A thread beneath this task directory belongs to this PID's thread group.
    // Never use an unrelated /proc/<tid> or saved PID marker as identity evidence.
    for (const tid of fs.readdirSync(`${root}/task`)) {
      if (!/^[1-9]\d*$/.test(tid) || tid === String(pid)) continue;
      const threadValue = readEntry(`${root}/task/${tid}`, entry);
      if (threadValue !== null && (entry === "exe" || threadValue.trim() !== "")) {
        return threadValue;
      }
    }
  } catch {
    // A vanished or unreadable thread group cannot establish process identity.
  }
  return value;
}
