// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for #5976: `nemoclaw onboard ... < /dev/null` printed the
 * provider menu, hit EOF on the first prompt read, and exited 0 silently
 * instead of reporting cancellation.
 *
 * Drives the real `prompt()` and `runOnboardCommand()` against an EOF stdin
 * in a subprocess (no Docker/gateway required) and asserts the flow now
 * prints "Installation cancelled" and exits non-zero. The subprocess requires
 * the *compiled* artifacts (`dist/lib/...js`) so it exercises the shipped CLI
 * path on the repo's minimum supported Node runtime — `node -e` has no
 * TypeScript loader, so requiring the `.ts` sources would only work on Node
 * versions with native type stripping.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const COMMAND_PATH = path.join(REPO_ROOT, "dist", "lib", "onboard", "command.js");
const STORE_PATH = path.join(REPO_ROOT, "dist", "lib", "credentials", "store.js");

describe("onboard with stdin EOF (#5976)", () => {
  it("reports cancellation and exits non-zero when a prompt hits EOF", () => {
    const script = `
const { runOnboardCommand } = require(${JSON.stringify(COMMAND_PATH)});
const { prompt } = require(${JSON.stringify(STORE_PATH)});
runOnboardCommand({
  flags: {},
  env: process.env,
  // Stand in for the interactive provider menu: the first read hits EOF.
  runOnboard: async () => {
    await prompt("  Choose [1]: ");
  },
  error: (message) => console.error(message),
  exit: (code) => process.exit(code),
}).then(
  () => {
    console.error("UNEXPECTED_RESOLVE");
    process.exit(42);
  },
  (err) => {
    console.error("UNEXPECTED_REJECT", err && err.stack ? err.stack : String(err));
    process.exit(43);
  },
);
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      // stdin "ignore" maps to /dev/null, so the prompt's readline closes
      // before any answer — exactly the reporter's `< /dev/null` scenario.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 10000,
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("Installation cancelled");
    expect(`${result.stdout}${result.stderr}`).not.toContain("UNEXPECTED_");
  });
});
