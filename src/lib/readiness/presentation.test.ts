// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createPublicReadinessReport, renderReadinessReport } from "./presentation";
import type { SystemReadinessReport } from "./types";

type ReadinessOutcome =
  | { status: "supported"; exitCode: 0 }
  | { status: "incompatible"; exitCode: 2 }
  | { status: "inconclusive"; exitCode: 3 };

type ReportOverrides = Partial<
  Omit<Extract<SystemReadinessReport, { status: "supported" }>, "status" | "exitCode">
>;

const NON_SUPPORTED_OUTCOMES = [
  { status: "incompatible", exitCode: 2 },
  { status: "inconclusive", exitCode: 3 },
] as const satisfies readonly ReadinessOutcome[];

function report(
  overrides: ReportOverrides = {},
  outcome: ReadinessOutcome = { status: "supported", exitCode: 0 },
): SystemReadinessReport {
  return {
    schemaVersion: "1.0.0",
    ...outcome,
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
  it("rejects reports that claim host mutation", () => {
    const mutatedReport = { ...report(), mutated: true } as unknown as SystemReadinessReport;

    expect(() => createPublicReadinessReport(mutatedReport)).toThrow(
      "Readiness reports must be observation-only.",
    );
  });

  it.each(NON_SUPPORTED_OUTCOMES)("preserves $status status and exit code $exitCode", (outcome) => {
    const publicReport = createPublicReadinessReport(report({}, outcome));

    expect(publicReport).toMatchObject({ ...outcome, mutated: false });
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
      report(
        {
          findings: [
            {
              id: "host.docker.unavailable",
              severity: "blocking",
              summary: "Docker is not installed.",
            },
          ],
        },
        { status: "incompatible", exitCode: 2 },
      ),
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

  it("retains a final required finding at the public boundary", () => {
    const warnings = Array.from({ length: 256 }, (_, index) => ({
      id: `host.boundary.${index}`,
      severity: "warning" as const,
      summary: `Warning ${index}`,
    }));
    const blocker = {
      id: "host.boundary.blocker",
      severity: "fatal" as const,
      summary: "A final required finding.",
    };

    const publicReport = createPublicReadinessReport(
      report({ findings: [...warnings, blocker] }, { status: "incompatible", exitCode: 2 }),
    );

    expect(publicReport.findings).toHaveLength(256);
    expect(publicReport.findings).toContainEqual(blocker);
    expect(publicReport.findings).not.toContainEqual(warnings.at(-1));
  });

  it("retains evidence referenced by a finding beyond the initial evidence boundary", () => {
    const evidence = Array.from({ length: 257 }, (_, index) => ({
      id: `host.boundary.evidence.${index}`,
      summary: `Evidence ${index}`,
    }));
    const blocker = {
      id: "host.boundary.blocker",
      severity: "blocking" as const,
      summary: "A blocker with late evidence.",
      evidenceIds: [evidence.at(-1)?.id ?? ""],
    };

    const publicReport = createPublicReadinessReport(
      report({ evidence, findings: [blocker] }, { status: "incompatible", exitCode: 2 }),
    );

    expect(publicReport.evidence).toHaveLength(256);
    expect(publicReport.evidence.map(({ id }) => id)).toContain(evidence.at(-1)?.id);
    expect(publicReport.evidence.map(({ id }) => id)).not.toContain(evidence.at(-2)?.id);
  });

  it("retains capabilities referenced by a qualification beyond the initial boundary", () => {
    const capabilities = Array.from({ length: 257 }, (_, index) => ({
      id: `host.boundary.capability.${index}`,
      state: "present" as const,
    }));
    const qualification = {
      id: "host.boundary.qualification",
      status: "qualified" as const,
      capabilityIds: [capabilities.at(-1)?.id ?? ""],
    };

    const publicReport = createPublicReadinessReport(
      report({ capabilities, qualifications: [qualification] }),
    );

    expect(publicReport.capabilities).toHaveLength(256);
    expect(publicReport.capabilities.map(({ id }) => id)).toContain(capabilities.at(-1)?.id);
    expect(publicReport.capabilities.map(({ id }) => id)).not.toContain(capabilities.at(-2)?.id);
  });

  it("fails closed when required findings exceed the public boundary", () => {
    const blockers = Array.from({ length: 257 }, (_, index) => ({
      id: `host.blocker.${index}`,
      severity: "blocking" as const,
      summary: `Blocker ${index}`,
    }));

    expect(() =>
      createPublicReadinessReport(
        report({ findings: blockers }, { status: "incompatible", exitCode: 2 }),
      ),
    ).toThrow("Readiness report exceeds the public boundary for required findings.");
  });
});
