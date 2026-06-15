// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildCliDistCoverageArgs } from "../scripts/coverage-cli-dist-signal";

describe("coverage-cli-dist-signal", () => {
  it("builds a Vitest command that includes dist files and remappable source files", () => {
    const args = buildCliDistCoverageArgs();

    expect(args).toEqual(
      expect.arrayContaining([
        "vitest",
        "run",
        "--project",
        "cli",
        "--coverage",
        "--coverage.provider=v8",
        "--coverage.reportOnFailure",
        "--coverage.include=src/**/*.ts",
        "--coverage.include=dist/**/*.js",
        "--coverage.include=bin/**/*.js",
        "--coverage.exclude=nemoclaw/**",
      ]),
    );
    expect(args).toContain("--coverage.reportsDirectory=coverage/cli-dist-signal");
  });

  it("appends user-supplied filters after the coverage configuration", () => {
    const args = buildCliDistCoverageArgs(["src/lib/actions/sandbox/status-flow.test.ts"]);

    expect(args.at(-1)).toBe("src/lib/actions/sandbox/status-flow.test.ts");
  });
});
