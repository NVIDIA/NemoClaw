// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import systemReadinessSchema from "../../../schemas/system-readiness.schema.json" with { type: "json" };
import { checkSystemReadinessSchemaVersion } from "./compatibility.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureRoot = `${repositoryRoot}/test/fixtures/system-readiness`;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function isRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
    value,
  );
  const [, yearText = "0", monthText = "0", dayText = "0"] = match ?? [];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return (
    match !== null &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
  );
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
    },
  );

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

  it("rejects status and exit-code mismatches (#7409)", async () => {
    const validate = await createValidator();
    const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;

    expect(validate({ ...fixture, exitCode: 2 })).toBe(false);
  });

  it("rejects mutation and unbounded evidence (#7409)", async () => {
    const validate = await createValidator();
    const fixture = (await readJson(`${fixtureRoot}/supported.json`)) as Record<string, unknown>;
    const evidence = [{ id: "probe.output", summary: "x".repeat(1025) }];

    expect(validate({ ...fixture, mutated: true })).toBe(false);
    expect(validate({ ...fixture, evidence })).toBe(false);
  });
});
