// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export type RouterLaunchLog = {
  args: string[];
  cwd: string;
  env: Record<string, string | null>;
  pid: number;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopTestProcess(pid: number | null): Promise<void> {
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process exited between the final probe and cleanup.
  }
}

export async function readRouterLaunchLog(
  logPath: string,
  expectedEntries: number,
): Promise<RouterLaunchLog[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(logPath)) {
      const entries = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RouterLaunchLog);
      if (entries.length >= expectedEntries) return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedEntries} Model Router launch log entries`);
}
