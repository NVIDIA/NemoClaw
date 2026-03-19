// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

    assert.equal(result.status, 1, "process should exit with status 1");
    assert.equal(
      fs.existsSync(tmp),
      false,
      "build context temp dir should be removed by exit handler",
    );
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

    assert.equal(result.status, 0, "process should exit cleanly");
    assert.equal(
      fs.existsSync(tmp),
      false,
      "build context should be cleaned up on success",
    );
  });
});
