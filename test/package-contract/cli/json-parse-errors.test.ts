// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");

describe("doctor JSON argument errors", () => {
  it.each([
    ["--text", "--json"],
    ["--json", "--text"],
  ])("reports %s %s with one concise JSON error and a stderr diagnostic (#11150)", (...flags) => {
    const result = spawnSync(process.execPath, [CLI, "doctor", ...flags], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1_000);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        message: "--json and --text are mutually exclusive. Use one or the other.",
        exit: 2,
      },
    });
    expect(result.stderr).toContain("--json and --text are mutually exclusive");
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(1_000);
  });
});
