// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";
import Ajv, { type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import { projectSmsRegistrationSchema } from "../../scripts/telemetry/generate-sms-schema.mts";

type Schema = Record<string, unknown>;
function fixture(properties: Schema, extra: Schema = {}, name = "example"): Schema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $comment: "Synthetic schema fixture",
    schemaMeta: {
      schemaVersion: "2.0",
      definitionVersion: "2.0",
      clientId: "fixture",
      clientName: "Synthetic",
      personalization: "anonymous",
    },
    description: "Synthetic generator input",
    oneOf: [{ $ref: "#/definitions/events/" + name }],
    definitions: {
      types: {},
      events: {
        [name]: {
          eventMeta: {
            service: "telemetry",
            gdpr: { category: "functional", description: "Fixture" },
          },
          description: "Synthetic event",
          type: "object",
          additionalProperties: false,
          properties,
          required: Object.keys(properties),
          ...extra,
        },
      },
    },
  };
}
function event(schema: Schema, name = "example"): Schema {
  return (schema.definitions as { events: Record<string, Schema> }).events[name];
}
function properties(schema: Schema, name = "example"): Record<string, Schema> {
  return event(schema, name).properties as Record<string, Schema>;
}
function accepts(schema: Schema, value: unknown): boolean {
  return Boolean(new Ajv({ strict: false }).compile(schema as AnySchema)(value));
}

describe("SMS registration generation", () => {
  it("preserves synthetic fields, types, required lists, closure and privacy metadata", () => {
    const source = fixture({
      source: { type: "string", const: "nemoclaw" },
      count: { type: "integer", const: 1, minimum: 0, maximum: 10 },
      nested: {
        type: "object",
        additionalProperties: false,
        properties: { flag: { type: "string", enum: ["true", "false", "unknown"] } },
        required: ["flag"],
      },
    });
    const output = projectSmsRegistrationSchema(source);
    expect(output.schemaMeta).toEqual(source.schemaMeta);
    expect(output.oneOf).toEqual(source.oneOf);
    expect(event(output).eventMeta).toEqual(event(source).eventMeta);
    expect(event(output).required).toEqual(event(source).required);
    expect(Object.keys(properties(output))).toEqual(Object.keys(properties(source)));
    expect(properties(output).source).toEqual({ type: "string", enum: ["nemoclaw"] });
    expect(properties(output).count).toEqual({ type: "integer", minimum: 1, maximum: 1 });
    expect(accepts(output, { source: "nemoclaw", count: 1, nested: { flag: "false" } })).toBe(true);
    expect(accepts(output, { source: "other", count: 1, nested: { flag: "false" } })).toBe(false);
    expect(accepts(output, { source: "nemoclaw", count: 2, nested: { flag: "false" } })).toBe(
      false,
    );
    expect(
      accepts(output, { source: "nemoclaw", count: 1, nested: { flag: "false", secret: "x" } }),
    ).toBe(false);
  });

  it("omits only explicit local-only rules while retaining direct patterns and array bounds", () => {
    const source = fixture(
      {
        label: {
          type: "string",
          minLength: 0,
          maxLength: 20,
          pattern: "^[A-Z.0-9 ]*$",
          not: { pattern: "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" },
          allOf: [{ if: { minLength: 1 }, then: { minLength: 2 } }],
        },
        channels: {
          type: "array",
          maxItems: 2,
          uniqueItems: true,
          items: { type: "string", enum: ["slack", "discord"] },
        },
      },
      { allOf: [{ not: { properties: { label: { const: "DENIED" } } } }] },
    );
    const output = projectSmsRegistrationSchema(source);
    expect(properties(output).label).toEqual({
      type: "string",
      minLength: 0,
      maxLength: 20,
      pattern: "^[A-Z.0-9 ]*$",
    });
    expect(accepts(output, { label: "192.0.2.1", channels: ["slack", "slack"] })).toBe(true);
    expect(accepts(output, { label: "CITY", channels: ["private-channel"] })).toBe(false);
    expect(accepts(output, { label: "CITY", channels: ["slack", "discord", "slack"] })).toBe(false);
    expect(Object.hasOwn(event(output), "allOf")).toBe(false);
    expect(Object.hasOwn(properties(output).channels, "uniqueItems")).toBe(false);
  });

  it("derives finite string alternatives from canonical positive branch constraints", () => {
    const name = "nemoclaw_configuration_observed";
    const source = fixture(
      { value: { type: "string" } },
      {
        allOf: [
          {
            oneOf: [
              {
                properties: {
                  value: { type: "string", const: "alpha", enum: ["alpha", "unused"] },
                },
              },
              {
                anyOf: [
                  { properties: { value: { type: "string", enum: ["beta"] } } },
                  { properties: { value: { type: "string", enum: ["gamma"] } } },
                ],
              },
            ],
          },
          { properties: { value: { type: "string", enum: ["alpha", "beta"] } } },
        ],
      },
      name,
    );
    const output = projectSmsRegistrationSchema(source);
    expect(properties(output, name).value.enum).toEqual(["alpha", "beta"]);
    expect(accepts(output, { value: "alpha" })).toBe(true);
    expect(accepts(output, { value: "beta" })).toBe(true);
    expect(accepts(output, { value: "gamma" })).toBe(false);
    expect(accepts(output, { value: "private-hostname" })).toBe(false);
  });

  it.each([{}, { pattern: "^[A-Z]*$" }])(
    "stops generation when a configuration-value alternative has no finite bound %j",
    (patch) => {
      const source = fixture(
        { value: { type: "string", ...patch } },
        {
          oneOf: [{ properties: { value: { enum: ["public"] } } }, { properties: {} }],
        },
        "nemoclaw_configuration_observed",
      );
      expect(() => projectSmsRegistrationSchema(source)).toThrow("finite public bound");
    },
  );

  it.each([
    { type: ["string", "integer"] },
    { type: "null" },
    { type: "integer", enum: ["1"] },
    { type: "string", enum: ["x", 1] },
    { type: "boolean", const: true },
    { type: "string", futureKeyword: true },
    { type: "string", allOf: [{ futureKeyword: true }] },
    { type: "array", items: { type: "string" }, contains: { type: "string" } },
  ])("rejects unsupported or unfamiliar synthetic property %j", (property) => {
    expect(() => projectSmsRegistrationSchema(fixture({ value: property }))).toThrow();
  });

  it("rejects optional or open synthetic objects rather than changing their contract", () => {
    expect(() =>
      projectSmsRegistrationSchema(fixture({ value: { type: "string" } }, { required: [] })),
    ).toThrow("required");
    expect(() =>
      projectSmsRegistrationSchema(
        fixture({ value: { type: "string" } }, { additionalProperties: true }),
      ),
    ).toThrow("closed");
  });

  it("keeps the checked registration artifact current through the generator check command", () => {
    const script = path.resolve(
      import.meta.dirname,
      "../../scripts/telemetry/generate-sms-schema.mts",
    );
    expect(execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" })).toContain(
      "Generated SMS registration schema is current",
    );
  });
});
