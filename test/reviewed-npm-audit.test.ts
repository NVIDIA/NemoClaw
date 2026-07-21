// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  exceedsAuditThreshold,
  installedPackageInventory,
  installedPackageResolutionInventory,
  packageInventory,
  parseAuditReport,
  remediateReviewedLock,
  vulnerabilityCounts,
} from "../scripts/audit-reviewed-npm-graph.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const AUDIT_MODULE_URL = pathToFileURL(
  path.join(REPO_ROOT, "scripts", "audit-reviewed-npm-graph.mts"),
).href;
const AUDIT_PROBE_SOURCE = `
import fs from "node:fs";
import { assertReviewedAuditFindings, remediateReviewedLock } from ${JSON.stringify(AUDIT_MODULE_URL)};
const input = JSON.parse(fs.readFileSync(0, "utf8"));
if (input.mode === "findings") {
  assertReviewedAuditFindings(input.report, input.expected, input.threshold);
} else if (input.mode === "lock") {
  remediateReviewedLock(input.lock, input.remediations);
} else {
  throw new Error("unknown reviewed npm audit probe mode");
}
`;
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json"), "utf-8"),
) as {
  historicalReview: {
    expectedFindings: Array<{
      advisories: Array<{ id: string; severity: "high" | "critical" }>;
      nodes: string[];
      packageName: string;
      severity: "high" | "critical";
    }>;
    remediatedPackages: Array<{
      integrity: string;
      name: string;
      nodes: Array<{ node: string; vulnerableVersion: string }>;
      tarballUrl: string;
      version: string;
    }>;
  };
  severityThreshold: "info" | "low" | "moderate" | "high" | "critical";
};

function reviewedHistoricalReport(): Record<string, unknown> {
  return {
    vulnerabilities: Object.fromEntries(
      CONFIG.historicalReview.expectedFindings.map((finding) => [
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

function reviewedHistoricalLock(): Record<string, unknown> {
  return {
    lockfileVersion: 3,
    packages: Object.fromEntries([
      ["", { name: "reviewed-fixture", version: "1.0.0" }],
      ...CONFIG.historicalReview.remediatedPackages.flatMap((reviewed) =>
        reviewed.nodes.map((entry) => [
          entry.node,
          {
            integrity: "sha512-vulnerable",
            resolved: `https://registry.npmjs.org/${reviewed.name}/-/vulnerable.tgz`,
            version: entry.vulnerableVersion,
          },
        ]),
      ),
    ]),
  };
}

function runAuditProbe(input: Record<string, unknown>) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", AUDIT_PROBE_SOURCE],
    { encoding: "utf8", input: JSON.stringify(input) },
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

  it("allows only the exact reviewed high and critical historical findings", () => {
    const report = reviewedHistoricalReport();
    const accepted = runAuditProbe({
      expected: CONFIG.historicalReview.expectedFindings,
      mode: "findings",
      report,
      threshold: CONFIG.severityThreshold,
    });
    expect(accepted.status, accepted.stderr).toBe(0);

    const vulnerabilities = report.vulnerabilities as Record<string, any>;
    vulnerabilities.tar.via.push({
      severity: "high",
      url: "https://github.com/advisories/GHSA-new0-high-risk",
    });
    const rejected = runAuditProbe({
      expected: CONFIG.historicalReview.expectedFindings,
      mode: "findings",
      report,
      threshold: CONFIG.severityThreshold,
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/raw npm audit findings changed/);
  });

  it("rejects unrelated high findings and reviewed-node drift", () => {
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
    const unrelatedResult = runAuditProbe({
      expected: CONFIG.historicalReview.expectedFindings,
      mode: "findings",
      report: unrelated,
      threshold: CONFIG.severityThreshold,
    });
    expect(unrelatedResult.status).toBe(1);
    expect(unrelatedResult.stderr).toMatch(/raw npm audit findings changed/);

    const movedNode = reviewedHistoricalReport();
    (movedNode.vulnerabilities as Record<string, any>).axios.nodes = ["node_modules/axios"];
    const movedNodeResult = runAuditProbe({
      expected: CONFIG.historicalReview.expectedFindings,
      mode: "findings",
      report: movedNode,
      threshold: CONFIG.severityThreshold,
    });
    expect(movedNodeResult.status).toBe(1);
    expect(movedNodeResult.stderr).toMatch(/raw npm audit findings changed/);
  });

  it("proves the exact reviewed nodes become tar 7.5.19 and Axios 1.18.0", () => {
    const remediated = remediateReviewedLock(
      reviewedHistoricalLock(),
      CONFIG.historicalReview.remediatedPackages,
    );
    expect(packageInventory(remediated.lock, ["axios", "tar"])).toEqual(remediated.inventory);
    expect(
      new Set(remediated.inventory.map((entry) => `${entry.packageName}@${entry.version}`)),
    ).toEqual(new Set(["axios@1.18.0", "tar@7.5.19"]));
    const installedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-installed-graph-"));
    try {
      for (const entry of remediated.inventory) {
        const packageRoot = path.join(installedRoot, entry.node);
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: entry.packageName, version: entry.version }),
        );
      }
      expect(installedPackageInventory(installedRoot, ["axios", "tar"])).toEqual(
        remediated.inventory,
      );
    } finally {
      fs.rmSync(installedRoot, { force: true, recursive: true });
    }
    expect(
      exceedsAuditThreshold(
        { info: 0, low: 1, moderate: 3, high: 0, critical: 0 },
        CONFIG.severityThreshold,
      ),
    ).toBe(0);
  });

  it("proves a nested dependency resolves to the fixed hoisted package", () => {
    const installedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-hoisted-graph-"));
    const parentRoot = path.join(installedRoot, "node_modules", "@openclaw", "fs-safe");
    const tarRoot = path.join(installedRoot, "node_modules", "tar");
    const logicalInventory = [
      {
        node: "node_modules/@openclaw/fs-safe/node_modules/tar",
        packageName: "tar",
        version: "7.5.19",
      },
      { node: "node_modules/tar", packageName: "tar", version: "7.5.19" },
    ];
    try {
      fs.mkdirSync(parentRoot, { recursive: true });
      fs.mkdirSync(tarRoot, { recursive: true });
      fs.writeFileSync(
        path.join(installedRoot, "package.json"),
        JSON.stringify({ dependencies: { "@openclaw/fs-safe": "0.0.0", tar: "7.5.19" } }),
      );
      fs.writeFileSync(
        path.join(parentRoot, "package.json"),
        JSON.stringify({
          dependencies: { tar: "7.5.19" },
          name: "@openclaw/fs-safe",
          version: "0.0.0",
        }),
      );
      fs.writeFileSync(
        path.join(tarRoot, "package.json"),
        JSON.stringify({ name: "tar", version: "7.5.19" }),
      );
      expect(installedPackageResolutionInventory(installedRoot, logicalInventory)).toEqual([
        { ...logicalInventory[0], resolvedNode: "node_modules/tar" },
        { ...logicalInventory[1], resolvedNode: "node_modules/tar" },
      ]);
    } finally {
      fs.rmSync(installedRoot, { force: true, recursive: true });
    }
  });

  it("rejects vulnerable-version or node drift before synthesizing the final lock proof", () => {
    const versionDrift = reviewedHistoricalLock();
    const packages = versionDrift.packages as Record<string, any>;
    packages["node_modules/tar"].version = "7.5.12";
    const versionResult = runAuditProbe({
      lock: versionDrift,
      mode: "lock",
      remediations: CONFIG.historicalReview.remediatedPackages,
    });
    expect(versionResult.status).toBe(1);
    expect(versionResult.stderr).toMatch(/raw npm package inventory changed/);

    const nodeDrift = reviewedHistoricalLock();
    (nodeDrift.packages as Record<string, any>)["node_modules/other/node_modules/tar"] = {
      version: "7.5.16",
    };
    const nodeResult = runAuditProbe({
      lock: nodeDrift,
      mode: "lock",
      remediations: CONFIG.historicalReview.remediatedPackages,
    });
    expect(nodeResult.status).toBe(1);
    expect(nodeResult.stderr).toMatch(/raw npm package inventory changed/);
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
