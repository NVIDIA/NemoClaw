// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type CoverageSummary,
  findCoverageFailures,
  type Thresholds,
} from "../scripts/check-coverage-ratchet";
import { renderChangedCoverageReport } from "../scripts/report-changed-coverage";
import {
  securityCoverageThresholds,
  securityCoverageThresholdsForRun,
} from "./helpers/security-coverage-thresholds";

const thresholds: Thresholds = {
  lines: 70,
  functions: 71,
  branches: 62,
  statements: 70,
};

function summary(overrides: Partial<Thresholds> = {}): CoverageSummary {
  const values = { ...thresholds, ...overrides };
  return {
    total: {
      lines: { pct: values.lines },
      functions: { pct: values.functions },
      branches: { pct: values.branches },
      statements: { pct: values.statements },
    },
  };
}

describe("coverage regression safeguards", () => {
  it("accepts metrics that exactly meet the aggregate ratchet (#6692)", () => {
    expect(findCoverageFailures(summary(), thresholds)).toEqual([]);
  });

  it("rejects any aggregate drop below the committed floor (#6692)", () => {
    expect(findCoverageFailures(summary({ lines: 69.99 }), thresholds)).toEqual([
      { metric: "lines", actual: 69.99, threshold: 70 },
    ]);
  });

  it("applies native per-file floors to each security-sensitive surface (#6692)", () => {
    expect(securityCoverageThresholds).toEqual({
      perFile: true,
      "nemoclaw/src/blueprint/ssrf.ts": {
        lines: 96,
        functions: 100,
        branches: 95,
        statements: 96,
      },
      "src/lib/security/{credential-filter,redact,redact-url}.ts": {
        lines: 98,
        functions: 92,
        branches: 86,
        statements: 96,
      },
      "src/lib/policy/index.ts": {
        lines: 66,
        functions: 68,
        branches: 57,
        statements: 66,
      },
      "src/lib/shields/transition-lock.ts": {
        lines: 85,
        functions: 82,
        branches: 78,
        statements: 83,
      },
    });
  });

  it("defers per-file floors until partial coverage shards are merged (#6692)", () => {
    expect(
      securityCoverageThresholdsForRun({ CLI_SHARD: "2", CLI_SHARD_COUNT: "8" }),
    ).toBeUndefined();
    expect(securityCoverageThresholdsForRun({ CLI_SHARD: "2" })).toBeUndefined();
    expect(securityCoverageThresholdsForRun({})).toBe(securityCoverageThresholds);
  });

  it("renders changed-file coverage as advisory feedback (#6692)", () => {
    const fileCoverage = {
      lines: { pct: 91.25 },
      functions: { pct: 100 },
      branches: { pct: 87.5 },
      statements: { pct: 90 },
    };
    const report = renderChangedCoverageReport(
      { total: fileCoverage, "src/lib/security/redact.ts": fileCoverage },
      ["README.md", "src/lib/security/redact.ts"],
      "Changed CLI coverage",
    );

    expect(report).toContain("This report is advisory");
    expect(report).toContain("`src/lib/security/redact.ts`");
    expect(report).toContain("| 90% | 87.50% | 100% | 91.25% |");
    expect(report).not.toContain("README.md");
  });
});
