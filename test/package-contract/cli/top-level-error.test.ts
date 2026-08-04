// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_PATH = JSON.stringify(path.join(REPO_ROOT, "bin", "nemoclaw.js"));
const PUBLIC_DISPATCH_PATH = JSON.stringify(
  path.join(REPO_ROOT, "dist", "lib", "cli", "public-dispatch.js"),
);

describe("compiled CLI top-level errors", () => {
  it("prints a concise error without an uncaught Node.js stack (#8202)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-top-level-error-"));
    const scriptPath = path.join(tmpDir, "top-level-error.js");
    const script = String.raw`
const dispatchPath = ${PUBLIC_DISPATCH_PATH};
require.cache[dispatchPath] = {
  id: dispatchPath,
  filename: dispatchPath,
  loaded: true,
  exports: {
    dispatchCli: () => Promise.reject(new Error("Sandbox base image override was rejected.")),
  },
};
require(${CLI_PATH});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_DISABLE_AUTO_DISPATCH: "0",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: Sandbox base image override was rejected.\n");
    expect(result.stderr).not.toMatch(/\n\s+at |Node\.js v/);
  });
});
