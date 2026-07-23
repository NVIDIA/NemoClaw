// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { checkSystemReadinessSchemaVersion } from "./compatibility.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const schemaPath = `${repositoryRoot}/schemas/system-readiness.schema.json`;
const fixtureRoot = `${repositoryRoot}/test/fixtures/system-readiness`;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date-time", { type: "string", validate: (value: string) => !Number.isNaN(Date.parse(value)) });
  return ajv.compile((await readJson(schemaPath)) as AnySchema);
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
  });

  it("rejects unknown schema majors before reading the report (#7409)", () => {
    expect(checkSystemReadinessSchemaVersion("2.0.0")).toEqual({
      compatible: false,
      major: 2,
      reason: "unsupported system readiness schema major 2",
    });
    expect(checkSystemReadinessSchemaVersion("not-a-version").compatible).toBe(false);
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
