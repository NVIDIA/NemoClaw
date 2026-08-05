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

function expectTopLevelError(rejection: string, expectedStderr: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--eval",
      `const path = ${dispatchPath};
require.cache[path] = {
  loaded: true,
  exports: { dispatchCli: () => Promise.reject(${rejection}) },
};
require(${cliPath});`,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_DISABLE_AUTO_DISPATCH: "0",
        NEMOCLAW_LOG_LEVEL: "info",
        NEMOCLAW_DEBUG: "0",
      },
    },
  );

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(expectedStderr);
  expect(result.stderr).not.toMatch(/\n\s+at |Node\.js v/);
}

describe("compiled CLI top-level errors", () => {
  it("prints an Error rejection as one line without a Node.js stack (#8202)", () => {
    expectTopLevelError('new Error("Command failed.")', "Error: Command failed.\n");
  });

  it("prints a non-Error rejection as one line without a Node.js stack (#8202)", () => {
    expectTopLevelError('"String failure."', "Error: String failure.\n");
  });

  it("prints a safe fallback when a rejected value cannot be converted to text (#8202)", () => {
    expectTopLevelError(
      '{ [Symbol.toPrimitive]() { throw new Error("coercion failed"); } }',
      "Error: Command failed.\n",
    );
  });

  it("replaces rejected error line breaks and redacts credentials (#8202)", () => {
    const secret = `nvapi-${"a".repeat(20)}`;
    const rejection = `new Error(${JSON.stringify(`First line\n${secret}\r\nLast line`)})`;
    expectTopLevelError(rejection, "Error: First line <REDACTED> Last line\n");
  });
});
