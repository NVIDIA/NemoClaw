// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AuditExceptionRegistry,
  assertExceptionGraphs,
  evaluateAuditPolicy,
  exceedsAuditThreshold,
  parseAuditExceptionRegistry,
  parseAuditReport,
  readAuditExceptionRegistry,
  vulnerabilityCounts,
} from "../scripts/lib/reviewed-npm-audit.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json"), "utf-8"),
) as {
  severityThreshold: "info" | "low" | "moderate" | "high" | "critical";
};
const EMPTY_POLICY = parseAuditExceptionRegistry(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "npm-audit-exceptions.json"), "utf-8"),
);
const NOW = new Date("2026-07-21T12:00:00Z");

function withInstalledGraph(
  packages: Readonly<Record<string, string>>,
  run: (directory: string) => void,
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-audit-test-"));
  try {
    for (const [name, version] of Object.entries(packages)) {
      const packageDirectory = path.join(directory, "node_modules", ...name.split("/"));
      fs.mkdirSync(packageDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(packageDirectory, "package.json"),
        `${JSON.stringify({ name, version })}\n`,
      );
    }
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function highFindingReport(advisory = "GHSA-aaaa-bbbb-cccc") {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      parent: {
        name: "parent",
        severity: "high",
        isDirect: true,
        via: ["vulnerable-package"],
        effects: [],
        nodes: ["node_modules/parent"],
      },
      "vulnerable-package": {
        name: "vulnerable-package",
        severity: "high",
        isDirect: false,
        via: [
          {
            source: 123456,
            name: "vulnerable-package",
            dependency: "vulnerable-package",
            title: "test advisory",
            url: `https://github.com/advisories/${advisory}`,
            severity: "high",
            range: "<=1.0.0",
          },
        ],
        effects: ["parent"],
        nodes: ["node_modules/vulnerable-package"],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 },
    },
  };
}

function exceptionPolicy(
  overrides: Readonly<Record<string, unknown>> = {},
): AuditExceptionRegistry {
  return parseAuditExceptionRegistry(
    JSON.stringify({
      schemaVersion: 1,
      exceptions: [
        {
          advisory: "GHSA-aaaa-bbbb-cccc",
          package: "vulnerable-package",
          installedVersion: "1.0.0",
          graph: "test-graph",
          severity: "high",
          decision: "temporary-risk-acceptance",
          expires: "2026-07-28",
          owner: "security-maintainers",
          trackingIssue: "https://github.com/NVIDIA/NemoClaw/issues/1234",
          rationale: "The fix is in validation.",
          compensatingControls: ["The vulnerable input is rejected before this package runs."],
          ...overrides,
        },
      ],
    }),
    NOW,
  );
}

describe("reviewed npm audit gate", () => {
  it("uses an empty exception registry by default", () => {
    expect(EMPTY_POLICY).toEqual({ schemaVersion: 1, exceptions: [] });
  });

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

  it("accepts one exact blocking advisory and its propagated meta-vulnerability", () => {
    withInstalledGraph({ parent: "2.0.0", "vulnerable-package": "1.0.0" }, (directory) => {
      const result = evaluateAuditPolicy({
        directory,
        exceptionPolicy: exceptionPolicy(),
        exceptionPolicySha256: "a".repeat(64),
        graph: "test-graph",
        report: highFindingReport(),
        threshold: "high",
      });
      expect(result.status).toBe("accepted-exceptions");
      expect(result.acceptedAdvisories).toEqual(["GHSA-aaaa-bbbb-cccc"]);
      expect(result.unacceptedBlockingAdvisories).toEqual([]);
    });
  });

  it("does not let one exception suppress another blocking advisory", () => {
    withInstalledGraph(
      { parent: "2.0.0", "other-package": "3.0.0", "vulnerable-package": "1.0.0" },
      (directory) => {
        const report = highFindingReport() as Record<string, unknown>;
        const vulnerabilities = report.vulnerabilities as Record<string, unknown>;
        vulnerabilities["other-package"] = {
          name: "other-package",
          severity: "high",
          isDirect: false,
          via: [
            {
              source: 654321,
              name: "other-package",
              dependency: "other-package",
              title: "another advisory",
              url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
              severity: "high",
              range: "<=3.0.0",
            },
          ],
          effects: [],
          nodes: ["node_modules/other-package"],
        };
        const metadata = report.metadata as {
          vulnerabilities: { high: number };
        };
        metadata.vulnerabilities.high = 3;
        const result = evaluateAuditPolicy({
          directory,
          exceptionPolicy: exceptionPolicy(),
          exceptionPolicySha256: "a".repeat(64),
          graph: "test-graph",
          report,
          threshold: "high",
        });
        expect(result.status).toBe("blocked");
        expect(result.unacceptedBlockingAdvisories).toEqual([
          {
            advisory: "GHSA-dddd-eeee-ffff",
            installedVersion: "3.0.0",
            package: "other-package",
            severity: "high",
          },
        ]);
      },
    );
  });

  it("rejects an exception that does not match a reported finding", () => {
    withInstalledGraph({ parent: "2.0.0", "vulnerable-package": "1.0.0" }, (directory) => {
      expect(() =>
        evaluateAuditPolicy({
          directory,
          exceptionPolicy: exceptionPolicy({ installedVersion: "1.0.1" }),
          exceptionPolicySha256: "a".repeat(64),
          graph: "test-graph",
          report: highFindingReport(),
          threshold: "high",
        }),
      ).toThrow(/unused npm audit exceptions/);
    });
  });

  it("rejects exception graph IDs outside the configured production inventory", () => {
    expect(() => assertExceptionGraphs(exceptionPolicy(), new Set(["production-graph"]))).toThrow(
      /unknown graphs: test-graph/,
    );
  });

  it.each([
    ["expired", { expires: "2026-07-20" }, /expired/],
    ["invalid date", { expires: "2026-02-31" }, /YYYY-MM-DD/],
    ["overlong", { expires: "2026-09-01" }, /within 30 days/],
    ["unknown field", { extra: true }, /unknown fields/],
    ["missing controls", { compensatingControls: undefined }, /compensatingControls is required/],
    ["foreign issue", { trackingIssue: "https://github.com/example/project/issues/1" }, /NemoClaw/],
  ])("rejects an %s exception", (_label, overrides, message) => {
    expect(() => exceptionPolicy(overrides)).toThrow(message);
  });

  it("rejects a missing exception registry instead of treating it as empty", () => {
    expect(() => readAuditExceptionRegistry(path.join(REPO_ROOT, "ci", "missing.json"))).toThrow(
      /ENOENT/,
    );
  });
});
