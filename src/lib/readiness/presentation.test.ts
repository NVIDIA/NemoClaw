// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createPublicHostProbeReadinessReport,
  createPublicReadinessReport,
  renderReadinessReport,
} from "./presentation";
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
    schemaVersion: "1.1.0",
    ...outcome,
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "21e60ae287e8c2a184f71406ac8b418f046330d1",
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

  it("admits a sole storage conflict when supported lifecycle remediation is available (#8849)", () => {
    const strictReport = report(
      {
        capabilities: [
          { id: "host.docker.storage_compatible", state: "absent" },
          { id: "host.docker.storage_remediation_available", state: "present" },
        ],
        findings: [
          {
            id: "host.docker.storage_incompatible",
            severity: "blocking",
            summary: "The Docker storage configuration cannot support nested overlay mounts.",
            capabilityIds: ["host.docker.storage_compatible"],
          },
        ],
      },
      { status: "incompatible", exitCode: 2 },
    );

    const publicReport = createPublicHostProbeReadinessReport(strictReport);

    expect(publicReport).toMatchObject({ status: "supported", exitCode: 0, mutated: false });
    expect(publicReport.findings).toContainEqual(
      expect.objectContaining({
        id: "host.docker.storage_incompatible",
        severity: "warning",
      }),
    );
    expect(strictReport).toMatchObject({ status: "incompatible", exitCode: 2 });
    expect(strictReport.findings[0]).toMatchObject({ severity: "blocking" });
  });

  it.each([
    {
      name: "remediation is unavailable",
      capabilities: [
        { id: "host.docker.storage_compatible", state: "absent" as const },
        { id: "host.docker.storage_remediation_available", state: "absent" as const },
      ],
      findings: [
        {
          id: "host.docker.storage_incompatible",
          severity: "blocking" as const,
          summary: "The Docker storage configuration cannot support nested overlay mounts.",
          capabilityIds: ["host.docker.storage_compatible"],
        },
      ],
    },
    {
      name: "another blocker remains",
      capabilities: [
        { id: "host.docker.storage_compatible", state: "absent" as const },
        { id: "host.docker.storage_remediation_available", state: "present" as const },
        { id: "host.docker.daemon_reachable", state: "absent" as const },
      ],
      findings: [
        {
          id: "host.docker.storage_incompatible",
          severity: "blocking" as const,
          summary: "The Docker storage configuration cannot support nested overlay mounts.",
          capabilityIds: ["host.docker.storage_compatible"],
        },
        {
          id: "host.docker.daemon_unreachable",
          severity: "blocking" as const,
          summary: "The Docker daemon is unreachable.",
          capabilityIds: ["host.docker.daemon_reachable"],
        },
      ],
    },
  ])("keeps host probe incompatible when $name (#8849)", ({ capabilities, findings }) => {
    const publicReport = createPublicHostProbeReadinessReport(
      report({ capabilities, findings }, { status: "incompatible", exitCode: 2 }),
    );

    expect(publicReport).toMatchObject({ status: "incompatible", exitCode: 2 });
    expect(publicReport.findings.filter(({ severity }) => severity === "blocking")).toEqual(
      findings,
    );
  });

  it("preserves valid immutable build provenance (#7777)", () => {
    const sourceRevision = `8bfff4526${"a".repeat(31)}`;
    const publicReport = createPublicReadinessReport(
      report({
        provenance: {
          nemoclawVersion: "0.0.96-35-g8bfff4526",
          sourceRevision,
          observedAt: "2026-06-01T12:00:00.000Z",
        },
      }),
    );

    expect(publicReport.provenance).toMatchObject({
      nemoclawVersion: "0.0.96-35-g8bfff4526",
      sourceRevision,
    });
  });

  it.each([
    `nvapi-${"a".repeat(24)}`,
    "not-a-source-revision",
  ])("rejects the invalid source revision %s (#7777)", (sourceRevision) => {
    expect(() =>
      createPublicReadinessReport(
        report({
          provenance: {
            nemoclawVersion: "0.1.0",
            observedAt: "2026-06-01T12:00:00.000Z",
            sourceRevision,
          },
        }),
      ),
    ).toThrow("NemoClaw build identity has an invalid source revision.");
  });

  it("rejects a described version that names a different source revision (#7777)", () => {
    expect(() =>
      createPublicReadinessReport(
        report({
          provenance: {
            nemoclawVersion: "0.0.96-35-g8bfff4526",
            sourceRevision: "9".repeat(40),
            observedAt: "2026-06-01T12:00:00.000Z",
          },
        }),
      ),
    ).toThrow("NemoClaw build identity version and source revision do not match.");
  });

  it("rejects token-like public build versions (#7777)", () => {
    const token = `nvapi-${"a".repeat(24)}`;

    expect(() =>
      createPublicReadinessReport(
        report({
          provenance: {
            nemoclawVersion: token,
            sourceRevision: "21e60ae287e8c2a184f71406ac8b418f046330d1",
            observedAt: "2026-06-01T12:00:00.000Z",
          },
        }),
      ),
    ).toThrow("NemoClaw build identity has an invalid version.");
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
        provenance: {
          nemoclawVersion: "0.1.0",
          sourceRevision: "21e60ae287e8c2a184f71406ac8b418f046330d1",
          observedAt: "2026-06-01T12:00:00.000Z",
        },
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

  it.each([
    { label: "single quote", quote: "'" },
    { label: "double quote", quote: '"' },
  ])("redacts URL credentials split by a $label at the public boundary", ({ quote }) => {
    const publicReport = createPublicReadinessReport(
      report({
        evidence: [
          {
            id: "host.probe.output",
            summary: `https://service-user:service-password${quote}opaque@example.test/path`,
          },
        ],
      }),
    );

    expect(publicReport.evidence[0]?.summary).toBe("https://example.test/path");
  });

  it("neutralizes terminal and bidirectional controls across the public report", () => {
    const unsafe = "trusted\n\u001b[31mforged\u202efailure";
    const publicReport = createPublicReadinessReport(
      report({
        observations: [{ id: "host.identity", state: "present", value: unsafe }],
        findings: [{ id: "host.finding", severity: "warning", summary: unsafe }],
        evidence: [{ id: "host.evidence", summary: unsafe, details: { productName: unsafe } }],
      }),
    );
    const serialized = JSON.stringify(publicReport);

    expect(serialized).toContain("trusted\\\\u000a\\\\u001b[31mforged\\\\u202efailure");
    expect(serialized).not.toMatch(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u,
    );
  });

  it("excludes camel-cased and suffixed process environment keys", () => {
    const publicReport = createPublicReadinessReport(
      report({
        evidence: [
          {
            id: "host.probe.output",
            summary: "Probe output",
            details: {
              processEnvironmentVariables: "HOME=/private/home PATH=/private/bin",
              processEnvDumpV2: "USER=private-user",
              stderr: "Docker is unavailable.",
            },
          },
        ],
      }),
    );

    expect(publicReport.evidence[0]?.details).toEqual({ stderr: "Docker is unavailable." });
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

  it("fails closed when a finding exceeds its capability-reference boundary", () => {
    const capabilities = Array.from({ length: 65 }, (_, index) => ({
      id: `host.capability.${index}`,
      state: "present" as const,
    }));
    const blocker = {
      id: "host.boundary.blocker",
      severity: "blocking" as const,
      summary: "A blocker with too many capability references.",
      capabilityIds: capabilities.map(({ id }) => id),
    };

    expect(() =>
      createPublicReadinessReport(
        report({ capabilities, findings: [blocker] }, { status: "incompatible", exitCode: 2 }),
      ),
    ).toThrow("Readiness report exceeds the public boundary for finding capability references.");
  });

  it("fails closed when an observation exceeds its evidence-reference boundary", () => {
    const evidence = Array.from({ length: 33 }, (_, index) => ({
      id: `host.evidence.${index}`,
      summary: `Evidence ${index}`,
    }));
    const observation = {
      id: "host.observation",
      state: "present" as const,
      evidenceIds: evidence.map(({ id }) => id),
    };

    expect(() =>
      createPublicReadinessReport(report({ evidence, observations: [observation] })),
    ).toThrow("Readiness report exceeds the public boundary for observation evidence references.");
  });

  it("fails closed when a retained reference array contains duplicate IDs", () => {
    const evidence = [{ id: "host.evidence", summary: "Evidence" }];
    const observation = {
      id: "host.observation",
      state: "present" as const,
      evidenceIds: [evidence[0].id, evidence[0].id],
    };

    expect(() =>
      createPublicReadinessReport(report({ evidence, observations: [observation] })),
    ).toThrow("Readiness report contains duplicate observation evidence references.");
  });

  it("fails closed when required capability references exceed the collection boundary", () => {
    const capabilities = Array.from({ length: 257 }, (_, index) => ({
      id: `host.capability.${index}`,
      state: "present" as const,
    }));
    const blockers = Array.from({ length: 5 }, (_, index) => ({
      id: `host.boundary.blocker.${index}`,
      severity: "blocking" as const,
      summary: "A blocker with required capabilities.",
      capabilityIds: capabilities.slice(index * 64, (index + 1) * 64).map(({ id }) => id),
    }));

    expect(() =>
      createPublicReadinessReport(
        report({ capabilities, findings: blockers }, { status: "incompatible", exitCode: 2 }),
      ),
    ).toThrow("Readiness report exceeds the public boundary for referenced capability entries.");
  });

  it("fails closed when a required capability reference does not resolve", () => {
    const blocker = {
      id: "host.boundary.blocker",
      severity: "blocking" as const,
      summary: "A blocker with a missing capability.",
      capabilityIds: ["host.capability.missing"],
    };

    expect(() =>
      createPublicReadinessReport(
        report({ findings: [blocker] }, { status: "incompatible", exitCode: 2 }),
      ),
    ).toThrow("Readiness report contains unresolved capability references.");
  });

  it("rejects conflicting capabilities that use the same stable ID", () => {
    const capabilities = [
      { id: "host.capability", state: "present" as const },
      { id: "host.capability", state: "absent" as const },
    ];

    expect(() => createPublicReadinessReport(report({ capabilities }))).toThrow(
      "Readiness report contains duplicate capability IDs.",
    );
  });
});
