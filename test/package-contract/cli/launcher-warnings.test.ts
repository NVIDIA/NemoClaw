// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const LAUNCHER = path.join(import.meta.dirname, "..", "..", "..", "bin", "nemoclaw.js");

describe("CLI launcher warnings (#12741)", () => {
  it("drops only the node:sqlite ExperimentalWarning", () => {
    // Emit the warnings after the launcher installs its filter, so the result does not
    // depend on whether this Node version still marks node:sqlite as experimental.
    const script = `
      process.argv = [process.execPath, ${JSON.stringify(LAUNCHER)}, "--version"];
      require(${JSON.stringify(LAUNCHER)});
      process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
      process.emitWarning("another experimental feature", "ExperimentalWarning");
      process.emitWarning("a deprecated feature", "DeprecationWarning");
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, NEMOCLAW_GATEWAY_PORT: "8080" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^nemoclaw v/);
    expect(result.stderr).not.toContain("SQLite is an experimental feature");
    expect(result.stderr).toContain("ExperimentalWarning: another experimental feature");
    expect(result.stderr).toContain("DeprecationWarning: a deprecated feature");
  }, 15_000);
});
