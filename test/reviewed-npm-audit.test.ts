// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditGraph,
  buildAuditProvenance,
  deriveAuditEndpoints,
  exceedsAuditThreshold,
  extractAdvisoryIds,
  parseAuditReport,
  provenanceSidecarPath,
  vulnerabilityCounts,
} from "../scripts/audit-reviewed-npm-graph.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json"), "utf-8"),
) as {
  severityThreshold: "info" | "low" | "moderate" | "high" | "critical";
};

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

describe("reviewed npm audit provenance", () => {
  const detectionReport = {
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    },
    vulnerabilities: {
      "fast-uri": {
        via: [
          {
            source: 1104001,
            name: "fast-uri",
            url: "https://github.com/advisories/GHSA-4c8g-83qw-93j6",
          },
          "ajv",
        ],
      },
      ajv: { via: ["fast-uri"] },
      tar: {
        via: [
          { url: "https://github.com/advisories/GHSA-23hp-3jrh-7fpw" },
          { url: "https://github.com/advisories/GHSA-4c8g-83qw-93j6" },
        ],
      },
    },
  };

  it("extracts sorted unique GHSA ids from a report", () => {
    expect(extractAdvisoryIds(detectionReport)).toEqual([
      "GHSA-23hp-3jrh-7fpw",
      "GHSA-4c8g-83qw-93j6",
    ]);
  });

  it.each([
    ["a clean report", { metadata: { vulnerabilities: {} } }],
    ["a report without vulnerabilities", {}],
    ["string-only via chains", { vulnerabilities: { ajv: { via: ["fast-uri"] } } }],
    ["a malformed vulnerabilities value", { vulnerabilities: [1, 2] }],
  ])("extracts no advisory ids from %s", (_label, report) => {
    expect(extractAdvisoryIds(report as Record<string, unknown>)).toEqual([]);
  });

  it.each([
    "https://registry.npmjs.org/",
    "https://registry.npmjs.org",
  ])("derives the bulk advisory endpoint npm audit uses from %s", (registry) => {
    const endpoints = deriveAuditEndpoints(registry);
    expect(endpoints).toEqual({
      configuredRegistry: registry,
      bulkAdvisoryEndpoint: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
      note: expect.stringMatching(/bulk advisory endpoint.*no advisory data/s),
    });
  });

  it("places the provenance sidecar next to its raw report", () => {
    expect(provenanceSidecarPath("/tmp/artifacts/reviewed-archive-graph.json")).toBe(
      "/tmp/artifacts/reviewed-archive-graph.provenance.json",
    );
  });

  it("builds a complete provenance record for one audited graph", () => {
    const provenance = buildAuditProvenance({
      finishedAt: "2026-07-21T20:09:41.000Z",
      label: "reviewed archive graph",
      nodeVersion: "v22.22.2",
      npmVersion: "10.9.7",
      packageSpecs: ["openclaw@2026.6.10", "@openclaw/slack@2026.6.10"],
      rawReportPath: "reviewed-archive-graph.json",
      registry: "https://registry.npmjs.org/",
      report: detectionReport,
      startedAt: "2026-07-21T20:09:12.000Z",
    });
    expect(provenance).toEqual({
      schemaVersion: 1,
      scanner: { name: "npm audit", npmVersion: "10.9.7", nodeVersion: "v22.22.2" },
      registry: deriveAuditEndpoints("https://registry.npmjs.org/"),
      run: { startedAt: "2026-07-21T20:09:12.000Z", finishedAt: "2026-07-21T20:09:41.000Z" },
      graph: {
        label: "reviewed archive graph",
        packageSpecs: ["openclaw@2026.6.10", "@openclaw/slack@2026.6.10"],
      },
      rawReportPath: "reviewed-archive-graph.json",
      advisoryIds: ["GHSA-23hp-3jrh-7fpw", "GHSA-4c8g-83qw-93j6"],
    });
    expect(provenance).not.toHaveProperty("failure");
  });

  it("records a failure marker so a failed audit attempt still leaves provenance", () => {
    const provenance = buildAuditProvenance({
      failure: "npm audit failed without vulnerability findings: ECONNREFUSED",
      finishedAt: "2026-07-21T20:09:41.000Z",
      label: "reviewed archive graph",
      nodeVersion: "v22.22.2",
      npmVersion: "10.9.7",
      packageSpecs: ["openclaw@2026.6.10"],
      rawReportPath: "reviewed-archive-graph.json",
      registry: "https://registry.npmjs.org/",
      report: {},
      startedAt: "2026-07-21T20:09:12.000Z",
    });
    expect(provenance.failure).toBe(
      "npm audit failed without vulnerability findings: ECONNREFUSED",
    );
    expect(provenance.advisoryIds).toEqual([]);
  });

  it.each([
    "",
    "   ",
  ])("records an unknown registry explicitly instead of deriving a nonsense endpoint (%j)", (registry) => {
    expect(deriveAuditEndpoints(registry)).toEqual({
      configuredRegistry: null,
      bulkAdvisoryEndpoint: null,
      note: expect.stringMatching(/registry could not be determined/),
    });
  });

  it("writes the failure sidecar before rethrowing when npm audit hard-fails", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-provenance-"));
    const originalPath = process.env.PATH;
    try {
      const fakeBin = path.join(tempRoot, "bin");
      fs.mkdirSync(fakeBin);
      // Fake npm: `npm audit` emits npm's parseable transport-error JSON and
      // exits 1; every other subcommand (registry introspection) fails hard.
      fs.writeFileSync(
        path.join(fakeBin, "npm"),
        [
          "#!/bin/sh",
          'test "$1" = "audit" && {',
          '  echo \'{"error":{"code":"ECONNREFUSED","summary":"registry unreachable"}}\'',
          "  exit 1",
          "}",
          "exit 7",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
      const reportPath = path.join(tempRoot, "graph.json");
      expect(() =>
        auditGraph(tempRoot, reportPath, {
          label: "fixture graph",
          nodeVersion: "v22.22.2",
          npmVersion: "10.9.7",
          packageSpecs: ["fixture@1.0.0"],
        }),
      ).toThrow(/ECONNREFUSED/);
      const sidecar = JSON.parse(
        fs.readFileSync(path.join(tempRoot, "graph.provenance.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(sidecar.failure).toMatch(/ECONNREFUSED/);
      expect(sidecar.advisoryIds).toEqual([]);
      expect(sidecar.rawReportPath).toBe("graph.json");
      expect(sidecar.registry).toEqual({
        configuredRegistry: null,
        bulkAdvisoryEndpoint: null,
        note: expect.stringMatching(/registry could not be determined/),
      });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
