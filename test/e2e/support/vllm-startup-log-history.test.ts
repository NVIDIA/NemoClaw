// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { VLLM_STARTUP_LOG_HISTORY_SCRIPT } from "../fixtures/vllm-startup-log-history.ts";

test("the restart fixture hides the first error behind 80 newer records (#14017)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-log-history-"));
  const runAttempt = () =>
    spawnSync("sh", ["-c", VLLM_STARTUP_LOG_HISTORY_SCRIPT], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
  try {
    const first = runAttempt();
    expect(first.status).toBe(1);
    expect(first.stderr.trim()).toBe("vllm: error: unrecognized arguments: --disable-log-requests");
    const second = runAttempt();
    expect(second.status).toBe(0);
    expect(second.stdout.trim().split("\n")).toHaveLength(79);
    expect(second.stderr.trim()).toBe("WARNING: Running pip as the 'root' user");
    expect(second.stdout).not.toContain("vllm: error:");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
