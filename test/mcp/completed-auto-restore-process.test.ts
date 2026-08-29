// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reproduceCompletedAutoRestoreContainment } from "../helpers/completed-auto-restore-process";

describe("completed auto-restore process reproduction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears its evidence deadline when the child exits early (#10094)", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-restore-child-"));
    vi.useFakeTimers();

    try {
      await expect(
        reproduceCompletedAutoRestoreContainment({
          nodePath: process.execPath,
          lockModulePath: path.join(stateDir, "missing-lock-module.cjs"),
          stateDir,
          sandboxName: "early-exit",
          processToken: "a".repeat(32),
        }),
      ).rejects.toThrow("timer child exited 1");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
