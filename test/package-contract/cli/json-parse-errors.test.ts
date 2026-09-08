// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SECRET = "nvapi-" + "a".repeat(24);

describe("JSON argument errors", () => {
  it.each([
    { args: ["doctor", "--text", "--json"], diagnostic: /cannot also be provided/ },
    { args: ["doctor", "--json", "--text"], diagnostic: /cannot also be provided/ },
    {
      args: ["sandbox", "doctor", "alpha", "--fix", "--json"],
      diagnostic: /cannot also be provided/,
    },
    { args: ["doctor", "--json", `--${SECRET}`], diagnostic: /Nonexistent flag.*<REDACTED>/ },
  ])("reports $args on stderr without parser internals (#11150)", ({ args, diagnostic }) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(2);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr).toMatch(diagnostic);
    expect(result.stderr.length).toBeLessThan(4096);
    expect(result.stderr).not.toContain(SECRET);
  });
});
