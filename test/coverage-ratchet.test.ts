// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { findCoverageFailures } from "../scripts/check-coverage-ratchet.mts";

const thresholds = {
  lines: 71.2,
  functions: 80.1,
  branches: 78.8,
  statements: 77.9,
};

function coverageSummary(lines: number) {
  return {
    total: {
      lines: { pct: lines },
      functions: { pct: thresholds.functions },
      branches: { pct: thresholds.branches },
      statements: { pct: thresholds.statements },
    },
  };
}

describe("coverage ratchet", () => {
  it("allows a drop of exactly 0.1 percentage point (#6692)", () => {
    expect(findCoverageFailures(coverageSummary(71.1), thresholds)).toEqual([]);
  });

  it("fails a drop of 0.11 percentage point (#6692)", () => {
    expect(findCoverageFailures(coverageSummary(71.09), thresholds)).toEqual([
      { metric: "lines", actual: 71.09, threshold: 71.2 },
    ]);
  });

  it("reports the one-sided allowed drop when the CLI fails (#6692)", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-coverage-ratchet-"));
    const summaryPath = join(directory, "coverage-summary.json");
    const thresholdPath = join(directory, "coverage-threshold.json");
    writeFileSync(summaryPath, JSON.stringify(coverageSummary(71.09)));
    writeFileSync(thresholdPath, JSON.stringify(thresholds));

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/check-coverage-ratchet.mts",
          relative(process.cwd(), summaryPath),
          relative(process.cwd(), thresholdPath),
          "Test coverage",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("lines: 71.09% < 71.2% (allowed drop: 0.1 percentage point)");
      expect(result.stderr).not.toContain("±");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports the .mts usage path when required arguments are missing (#6922)", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-coverage-ratchet.mts"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Usage: check-coverage-ratchet.mts <coverage-summary.json> <coverage-threshold.json> [label]",
    );
  });
});
