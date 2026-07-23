// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import systemReadinessSchema from "../../../schemas/system-readiness.schema.json" with {
  type: "json",
};
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
  ] as const)("emits a schema-valid %s report for exit %i", (status, exitCode) => {
    const ajv = new Ajv2020({ strict: true });
    ajv.addFormat("date-time", {
      type: "string",
      validate: (value: string) => !Number.isNaN(Date.parse(value)),
    });
    const validate = ajv.compile(systemReadinessSchema as AnySchema);
    const publicReport = createPublicReadinessReport(report({ status, exitCode }));

    expect(validate(publicReport), JSON.stringify(validate.errors)).toBe(true);
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
    expect(publicReport.evidence[0]?.summary.length).toBeLessThanOrEqual(1024);
    expect(String(publicReport.evidence[0]?.details?.stderr).length).toBeLessThanOrEqual(1024);
  });
});
