// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import systemReadinessSchema from "../../../schemas/system-readiness.schema.json" with { type: "json" };
import { checkSystemReadinessSchemaVersion } from "./compatibility.js";
import { getSystemReadinessReferenceErrors } from "./references.js";
import type { SystemReadinessReport } from "./types.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureRoot = `${repositoryRoot}/test/fixtures/system-readiness`;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function isRfc3339DateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  const [, yearText = "0", monthText = "0", dayText = "0"] = match ?? [];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return match !== null && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!;
}

async function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date-time", { type: "string", validate: isRfc3339DateTime });
  return ajv.compile(systemReadinessSchema as AnySchema);
}

describe("system readiness contract", () => {
  it.each(["supported", "incompatible", "inconclusive"])(
    "validates the %s golden fixture (#7409)",
    async (name) => {
      const validate = await createValidator();
      const fixture = await readJson(`${fixtureRoot}/${name}.json`);

      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
      expect(getSystemReadinessReferenceErrors(fixture as SystemReadinessReport)).toEqual([]);
    },
  );

  it("requires producer source identity starting with schema 1.1.0 (#7777)", async () => {
    const validate = await createValidator();
    const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;
    const provenance = { ...(fixture.provenance as Record<string, unknown>) };
    delete provenance.sourceRevision;

    expect(validate({ ...fixture, provenance })).toBe(false);
    expect(
      validate({ ...fixture, schemaVersion: "1.0.0", provenance }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it("rejects an invalid public producer version (#7777)", async () => {
    const validate = await createValidator();
    const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;
    const provenance = {
      ...(fixture.provenance as Record<string, unknown>),
      nemoclawVersion: `nvapi-${"a".repeat(24)}`,
    };

    expect(validate({ ...fixture, provenance })).toBe(false);
  });

  it("accepts optional fields in schema major 1 (#7409)", async () => {
    const validate = await createValidator();
    const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;
    fixture.consumerExtension = { value: true };

    expect(checkSystemReadinessSchemaVersion("1.7.4")).toEqual({ compatible: true, major: 1 });
    expect(validate({ ...fixture, schemaVersion: "1.7.4" }), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(checkSystemReadinessSchemaVersion("1.01.0").compatible).toBe(false);
    expect(validate({ ...fixture, schemaVersion: "1.01.0" })).toBe(false);
  });

  it("rejects unknown schema majors before reading the report (#7409)", () => {
    expect(checkSystemReadinessSchemaVersion("2.0.0")).toEqual({
      compatible: false,
      major: 2,
      reason: "unsupported system readiness schema major 2",
    });
    expect(checkSystemReadinessSchemaVersion("not-a-version").compatible).toBe(false);
  });

  it("rejects invalid calendar timestamps (#7409)", async () => {
    const validate = await createValidator();
    const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;
    const provenance = { ...(fixture.provenance as Record<string, unknown>) };

    expect(
      validate({
        ...fixture,
        provenance: { ...provenance, observedAt: "2026-02-30T00:00:00Z" },
      }),
    ).toBe(false);
  });

  it.each(["2026-06-01t12:00:00z", "0000-02-29T00:00:00Z"])(
    "accepts the RFC 3339 timestamp %s (#7409)",
    async (observedAt) => {
      const validate = await createValidator();
      const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;
      const provenance = { ...(fixture.provenance as Record<string, unknown>), observedAt };

      expect(validate({ ...fixture, provenance }), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it("rejects status and exit-code mismatches (#7409)", async () => {
    const validate = await createValidator();
    const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;

    expect(validate({ ...fixture, exitCode: 2 })).toBe(false);
  });

  it("pairs every readiness status with its exit code in TypeScript (#7409)", () => {
    const reportFields = {
      schemaVersion: "1.1.0",
      mutated: false,
      provenance: {
        nemoclawVersion: "0.1.0",
        sourceRevision: "21e60ae287e8c2a184f71406ac8b418f046330d1",
        observedAt: "2026-06-01T12:00:00Z",
      },
      observations: [],
      capabilities: [],
      qualifications: [],
      findings: [],
      evidence: [],
    } as const;
    const supported: SystemReadinessReport = {
      ...reportFields,
      status: "supported",
      exitCode: 0,
    };
    const incompatible: SystemReadinessReport = {
      ...reportFields,
      status: "incompatible",
      exitCode: 2,
    };
    const inconclusive: SystemReadinessReport = {
      ...reportFields,
      status: "inconclusive",
      exitCode: 3,
    };

    // @ts-expect-error A supported report requires exit code 0.
    const _supportedMismatch: SystemReadinessReport = {
      ...reportFields,
      status: "supported",
      exitCode: 2,
    };
    // @ts-expect-error An incompatible report requires exit code 2.
    const _incompatibleMismatch: SystemReadinessReport = {
      ...reportFields,
      status: "incompatible",
      exitCode: 3,
    };
    // @ts-expect-error An inconclusive report requires exit code 3.
    const _inconclusiveMismatch: SystemReadinessReport = {
      ...reportFields,
      status: "inconclusive",
      exitCode: 0,
    };

    expect([supported.exitCode, incompatible.exitCode, inconclusive.exitCode]).toEqual([0, 2, 3]);
  });

  it("rejects duplicate IDs and unresolved references (#7409)", async () => {
    const fixture = (await readJson(`${fixtureRoot}/incompatible.json`)) as SystemReadinessReport;
    const duplicateEvidence = {
      ...fixture,
      evidence: [...fixture.evidence, fixture.evidence[0]!],
    } as SystemReadinessReport;

    expect(getSystemReadinessReferenceErrors(duplicateEvidence)).toContain(
      "evidence contains duplicate ID docker.not-found",
    );

    const unresolvedReferences: ReadonlyArray<{
      report: SystemReadinessReport;
      error: string;
    }> = [
      {
        report: {
          ...fixture,
          observations: [
            {
              ...fixture.observations[0]!,
              evidenceIds: ["missing.evidence"],
            },
          ],
        },
        error: "observations[0].evidenceIds references unknown ID missing.evidence",
      },
      {
        report: {
          ...fixture,
          capabilities: [
            {
              ...fixture.capabilities[0]!,
              evidenceIds: ["missing.evidence"],
            },
          ],
        },
        error: "capabilities[0].evidenceIds references unknown ID missing.evidence",
      },
      {
        report: {
          ...fixture,
          qualifications: [
            {
              ...fixture.qualifications[0]!,
              capabilityIds: ["missing.capability"],
            },
          ],
        },
        error: "qualifications[0].capabilityIds references unknown ID missing.capability",
      },
      {
        report: {
          ...fixture,
          findings: [
            {
              ...fixture.findings[0]!,
              capabilityIds: ["missing.capability"],
            },
          ],
        },
        error: "findings[0].capabilityIds references unknown ID missing.capability",
      },
      {
        report: {
          ...fixture,
          findings: [
            {
              ...fixture.findings[0]!,
              evidenceIds: ["missing.evidence"],
            },
          ],
        },
        error: "findings[0].evidenceIds references unknown ID missing.evidence",
      },
    ];

    expect(unresolvedReferences.every(({ report, error }) =>
        getSystemReadinessReferenceErrors(report).includes(error))).toBe(true);
  });

  it("rejects mutation and unbounded evidence (#7409)", async () => {
    const validate = await createValidator();
    const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;
    const longSummary = [{ id: "probe.output", summary: "x".repeat(1025) }];
    const longExtension = [{ id: "probe.output", summary: "Probe output.", raw: "x".repeat(1025) }];
    const boundedExtension = [{ id: "probe.output", summary: "Probe output.", kind: "probe" }];

    expect(validate({ ...fixture, mutated: true })).toBe(false);
    expect(validate({ ...fixture, evidence: longSummary })).toBe(false);
    expect(validate({ ...fixture, evidence: longExtension })).toBe(false);
    expect(
      validate({ ...fixture, evidence: boundedExtension }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });
});
