// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const cliPath = JSON.stringify(path.join(REPO_ROOT, "bin", "nemoclaw.js"));
const dispatchPath = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "cli", "public-dispatch.js"),
);

describe("compiled CLI top-level errors", () => {
  it("prints one error line without an uncaught Node.js stack (#8202)", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        `const path = ${dispatchPath};
require.cache[path] = {
  loaded: true,
  exports: { dispatchCli: () => Promise.reject(new Error("Command failed.")) },
};
require(${cliPath});`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: { ...process.env, NEMOCLAW_DISABLE_AUTO_DISPATCH: "0" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: Command failed.\n");
    expect(result.stderr).not.toMatch(/\n\s+at |Node\.js v/);
  });
});
