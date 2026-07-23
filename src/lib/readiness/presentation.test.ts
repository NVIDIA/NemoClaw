// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createPublicReadinessReport, renderReadinessReport } from "./presentation";
import type { SystemReadinessReport } from "./types";

function report(overrides: Partial<SystemReadinessReport> = {}): SystemReadinessReport {
  return {
    schemaVersion: "1.0.0",
    status: "supported",
    exitCode: 0,
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      observedAt: "2026-06-01T12:00:00.000Z",
    },
    observations: [],
    capabilities: [],
    qualifications: [],
    findings: [],
    evidence: [],
    ...overrides,
  };
}

describe("public readiness presentation (#7412)", () => {
  it.each([
    ["incompatible", 2],
    ["inconclusive", 3],
  ] as const)("preserves %s status and exit code %i", (status, exitCode) => {
    const publicReport = createPublicReadinessReport(report({ status, exitCode }));

    expect(publicReport).toMatchObject({ status, exitCode, mutated: false });
  });

  it.each([
    [`nvapi-${"a".repeat(24)}`, undefined],
    ["not-a-source-revision", undefined],
    ["a".repeat(40), "a".repeat(40)],
  ])("publishes only immutable source revisions", (sourceRevision, expected) => {
    const publicReport = createPublicReadinessReport(
      report({
        provenance: {
          nemoclawVersion: "0.1.0",
          observedAt: "2026-06-01T12:00:00.000Z",
          sourceRevision,
        },
      }),
    );

    expect(publicReport.provenance.sourceRevision).toBe(expected);
  });

  it("renders human output from the same public report used for JSON", () => {
    const publicReport = createPublicReadinessReport(
      report({
        status: "incompatible",
        exitCode: 2,
        findings: [
          {
            id: "host.docker.unavailable",
            severity: "blocking",
            summary: "Docker is not installed.",
          },
        ],
      }),
    );

    expect(renderReadinessReport(publicReport)).toContain("System readiness: incompatible");
    expect(renderReadinessReport(publicReport)).toContain(
      "[blocking] host.docker.unavailable: Docker is not installed.",
    );
  });

  it("redacts secrets and excludes process environments at the public boundary", () => {
    const token = `nvapi-${"a".repeat(24)}`;
    const publicReport = createPublicReadinessReport(
      report({
        findings: [
          {
            id: "host.probe.failure",
            severity: "warning",
            summary: `token=${token}`,
            processEnv: { NVIDIA_API_KEY: token },
          },
        ],
        evidence: [
          {
            id: "host.probe.output",
            summary: `https://user:${token}@example.test/path?token=${token}${"x".repeat(1200)}`,
            details: {
              stderr: `${token}${"x".repeat(1200)}`,
              processEnv: `NVIDIA_API_KEY=${token}`,
              "processEnv.PATH": "/usr/bin",
              environmentDump: "HOME=/home/user",
              envVars: `NVIDIA_API_KEY=${token}`,
            },
          },
        ],
      }),
    );
    const serialized = JSON.stringify(publicReport);

    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("user:");
    expect(serialized).not.toContain("NVIDIA_API_KEY");
    expect(serialized).not.toContain("processEnv");
    expect(serialized).not.toContain("environmentDump");
    expect(serialized).not.toContain("envVars");
    expect(publicReport.evidence[0]?.summary.length).toBeLessThanOrEqual(1024);
    expect(String(publicReport.evidence[0]?.details?.stderr).length).toBeLessThanOrEqual(1024);
  });
});
