// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  exceedsAuditThreshold,
  parseAuditReport,
  vulnerabilityCounts,
} from "../scripts/audit-reviewed-npm-graph.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const AUDIT_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "scripts", "audit-reviewed-npm-graph.mts"),
).href;
const AUDIT_PROBE_SOURCE = `
import fs from "node:fs";
import { assertReviewedAuditFindings, highSeverityAuditFindings } from ${JSON.stringify(AUDIT_MODULE_URL)};
const input = JSON.parse(fs.readFileSync(0, "utf8"));
if (input.operation === "list") {
  highSeverityAuditFindings(input.report, input.threshold);
} else {
  assertReviewedAuditFindings(input.report, input.expected, input.threshold);
}
`;
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json"), "utf-8"),
) as {
  archiveReview: {
    expectedFindings: Array<{
      advisories: Array<{ id: string; severity: "high" | "critical" }>;
      nodes: string[];
      packageName: string;
      severity: "high" | "critical";
    }>;
  };
  severityThreshold: "info" | "low" | "moderate" | "high" | "critical";
};

function reviewedHistoricalReport(): Record<string, unknown> {
  return {
    vulnerabilities: Object.fromEntries(
      CONFIG.archiveReview.expectedFindings.map((finding) => [
        finding.packageName,
        {
          name: finding.packageName,
          nodes: finding.nodes,
          severity: finding.severity,
          via: finding.advisories.map((advisory) => ({
            severity: advisory.severity,
            url: `https://github.com/advisories/${advisory.id}`,
          })),
        },
      ]),
    ),
  };
}

function runAuditProbe(
  report: Record<string, unknown>,
  options: { operation?: "assert" | "list"; threshold?: typeof CONFIG.severityThreshold } = {},
) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", AUDIT_PROBE_SOURCE],
    {
      encoding: "utf8",
      input: JSON.stringify({
        expected: CONFIG.archiveReview.expectedFindings,
        operation: options.operation ?? "assert",
        report,
        threshold: options.threshold ?? CONFIG.severityThreshold,
      }),
    },
  );
}

describe("reviewed npm audit gate", () => {
  it("fails at high or critical findings while retaining lower severities", () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 3, low: 2, moderate: 1, high: 4, critical: 5 },
      },
    };
    const counts = vulnerabilityCounts(report);
    expect(exceedsAuditThreshold(counts, CONFIG.severityThreshold)).toBe(9);
    expect(exceedsAuditThreshold(counts, "critical")).toBe(5);
  });

  it("accepts npm's nonzero audit status when a complete finding report explains it", () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 },
      },
    };
    expect(parseAuditReport({ status: 1, stderr: "", stdout: JSON.stringify(report) })).toEqual(
      report,
    );
  });

  it("accepts the exact reviewed high and critical archive findings", () => {
    const result = runAuditProbe(reviewedHistoricalReport());
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a reviewed-findings threshold below high", () => {
    const result = runAuditProbe(reviewedHistoricalReport(), {
      operation: "list",
      threshold: "moderate",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reviewed raw npm audit threshold must be high or critical");
  });

  it("rejects a new advisory in the reviewed archive graph", () => {
    const report = reviewedHistoricalReport();
    const vulnerabilities = report.vulnerabilities as Record<
      string,
      { nodes: string[]; via: Array<Record<string, string>> }
    >;
    vulnerabilities.tar.via.push({
      severity: "high",
      url: "https://github.com/advisories/GHSA-new0-high-risk",
    });
    const result = runAuditProbe(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reviewed raw npm audit findings changed");
  });

  it("rejects an unrelated high finding in the reviewed archive graph", () => {
    const unrelated = reviewedHistoricalReport();
    (unrelated.vulnerabilities as Record<string, unknown>).unrelated = {
      name: "unrelated",
      nodes: ["node_modules/unrelated"],
      severity: "high",
      via: [
        {
          severity: "high",
          url: "https://github.com/advisories/GHSA-new0-unrelated-risk",
        },
      ],
    };
    const result = runAuditProbe(unrelated);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reviewed raw npm audit findings changed");
  });

  it("rejects reviewed archive node drift", () => {
    const movedNode = reviewedHistoricalReport();
    (
      movedNode.vulnerabilities as Record<
        string,
        { nodes: string[]; via: Array<Record<string, string>> }
      >
    ).axios.nodes = ["node_modules/axios"];
    const result = runAuditProbe(movedNode);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reviewed raw npm audit findings changed");
  });

  it("rejects a parseable npm transport failure instead of treating it as clean", () => {
    expect(() =>
      parseAuditReport({
        status: 1,
        stderr: "npm registry unavailable",
        stdout: JSON.stringify({
          error: { code: "ECONNREFUSED", summary: "request to registry failed" },
        }),
      }),
    ).toThrow(/ECONNREFUSED/);
  });

  it.each([
    ["missing metadata", {}],
    [
      "invalid severity count",
      { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: "0", critical: 0 } } },
    ],
  ])("rejects %s", (_label, report) => {
    expect(() =>
      parseAuditReport({ status: 0, stderr: "", stdout: JSON.stringify(report) }),
    ).toThrow(/vulnerability report|vulnerability count/);
  });
});
