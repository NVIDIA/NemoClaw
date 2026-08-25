// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("onboard build context cleanup", () => {
  it("removes the build context temp dir when a command fails mid-build", () => {
    // Simulate the pattern used in createSandbox: register a process 'exit'
    // handler to clean up the temp dir, then exit non-zero (as run() does
    // via process.exit on command failure). The handler must still fire.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-test-"));
    const marker = path.join(tmp, "sentinel.txt");
    fs.writeFileSync(marker, "build context contents");

    const result = spawnSync(
      "node",
      [
        "-e",
        `
        const fs = require("fs");
        const buildCtx = ${JSON.stringify(tmp)};
        const cleanup = () => {
          try { fs.rmSync(buildCtx, { recursive: true, force: true }); } catch {}
        };
        process.on("exit", cleanup);
        // Simulate run() calling process.exit() on command failure
        process.exit(1);
        `,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status).toBe(1);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("removes the build context on success and deregisters the handler", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cleanup-test-"));
    fs.writeFileSync(path.join(tmp, "sentinel.txt"), "build context contents");

    const result = spawnSync(
      "node",
      [
        "-e",
        `
        const fs = require("fs");
        const buildCtx = ${JSON.stringify(tmp)};
        const cleanup = () => {
          try { fs.rmSync(buildCtx, { recursive: true, force: true }); } catch {}
        };
        process.on("exit", cleanup);
        // Simulate successful path: explicit cleanup + deregister
        cleanup();
        process.removeListener("exit", cleanup);
        // Verify the specific handler was deregistered
        if (process.listeners("exit").includes(cleanup)) {
          console.error("exit handler was not deregistered");
          process.exit(2);
        }
        `,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("keeps the exit handler armed when inline cleanup fails", () => {
    // When fs.rmSync throws (e.g. EBUSY on Windows, permission denied),
    // the 'exit' safety net must remain registered so the temp dir is
    // still removed at process exit. Regression guard for the review
    // feedback "Don't drop the fallback cleanup after a failed rmSync".
    const result = spawnSync(
      "node",
      [
        "-e",
        `
        const fs = require("fs");
        const cleanup = () => {
          // Simulate cleanup failure
          try { throw new Error("simulated rmSync failure"); return true; }
          catch { return false; }
        };
        process.on("exit", cleanup);
        if (cleanup()) {
          process.removeListener("exit", cleanup);
        }
        if (!process.listeners("exit").includes(cleanup)) {
          console.error("exit handler was deregistered despite cleanup failure");
          process.exit(2);
        }
        `,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status).toBe(0);
  });
});
