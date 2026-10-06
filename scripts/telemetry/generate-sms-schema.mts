// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Schema = Record<string, unknown>;
const LOCAL_RULES = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "uniqueItems",
]);
const FIELD_KEYS = new Set([
  "type",
  "const",
  "enum",
  "description",
  "tasks",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
  ...LOCAL_RULES,
]);
const EVENT_KEYS = new Set([
  "eventMeta",
  "description",
  "type",
  "additionalProperties",
  "properties",
  "required",
  ...LOCAL_RULES,
]);
const ROOT_KEYS = new Set([
  "$schema",
  "$comment",
  "schemaMeta",
  "description",
  "oneOf",
  "definitions",
]);
const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);

function object(value: unknown): Schema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a schema object.");
  }
  return value as Schema;
}

function checkKeys(schema: Schema, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) throw new Error("Unrecognized schema keyword: " + key);
  }
}

function checkKnownRules(value: unknown): void {
  if (typeof value === "boolean") return;
  const schema = object(value);
  checkKeys(schema, new Set([...FIELD_KEYS, ...EVENT_KEYS, "$ref"]));
  if (schema.properties !== undefined) {
    for (const property of Object.values(object(schema.properties))) checkKnownRules(property);
  }
  if (schema.items !== undefined) checkKnownRules(schema.items);
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) for (const branch of schema[key]) checkKnownRules(branch);
  }
  for (const key of ["not", "if", "then", "else"]) {
    if (schema[key] !== undefined) checkKnownRules(schema[key]);
  }
}

function projectObject(schema: Schema): Schema {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new Error("SMS objects must be closed.");
  }
  const properties = object(schema.properties);
  const names = Object.keys(properties);
  if (
    !Array.isArray(schema.required) ||
    schema.required.length !== names.length ||
    !schema.required.every((name) => typeof name === "string" && Object.hasOwn(properties, name)) ||
    new Set(schema.required).size !== names.length
  ) {
    throw new Error("Every SMS object property must be required.");
  }
  return {
    properties: Object.fromEntries(names.map((name) => [name, projectProperty(properties[name])])),
    required: [...schema.required],
  };
}

function projectProperty(value: unknown): Schema {
  const schema = object(value);
  checkKeys(schema, FIELD_KEYS);
  if (typeof schema.type !== "string" || !TYPES.has(schema.type)) {
    throw new Error("SMS properties must have one supported non-null type.");
  }
  const result: Schema = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "const" && !LOCAL_RULES.has(key)),
  );
  if (
    Object.hasOwn(schema, "enum") &&
    (schema.type !== "string" ||
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      !schema.enum.every((item) => typeof item === "string"))
  ) {
    throw new Error("SMS enums must contain strings.");
  }
  if (Object.hasOwn(schema, "const")) {
    const fixed = schema.const;
    if (typeof fixed === "string" && schema.type === "string") {
      if (Array.isArray(schema.enum) && !schema.enum.includes(fixed)) {
        throw new Error("The string constant contradicts its enum.");
      }
      result.enum = [fixed];
    } else if (
      typeof fixed === "number" &&
      Number.isFinite(fixed) &&
      (schema.type === "number" || (schema.type === "integer" && Number.isInteger(fixed)))
    ) {
      if (
        (typeof schema.minimum === "number" && fixed < schema.minimum) ||
        (typeof schema.maximum === "number" && fixed > schema.maximum)
      )
        throw new Error("The numeric constant contradicts its bounds.");
      result.minimum = fixed;
      result.maximum = fixed;
    } else {
      throw new Error("The constant cannot be represented by SMS.");
    }
  }
  if (schema.type === "array") result.items = projectProperty(schema.items);
  if (schema.type === "object") Object.assign(result, projectObject(schema));
  return result;
}

function finiteStringValues(schema: Schema, field: string): Set<string> | null {
  const bounds: Set<string>[] = [];
  if (typeof schema.properties === "object" && schema.properties !== null) {
    const property = object(schema.properties)[field];
    if (typeof property === "object" && property !== null) {
      const declaration = object(property);
      if (typeof declaration.const === "string") bounds.push(new Set([declaration.const]));
      if (
        Array.isArray(declaration.enum) &&
        declaration.enum.every((value) => typeof value === "string")
      ) {
        bounds.push(new Set(declaration.enum as string[]));
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const bound = finiteStringValues(object(branch), field);
      if (bound) bounds.push(bound);
    }
  }
  for (const key of ["oneOf", "anyOf"]) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const branchBounds = branches.map((branch) => finiteStringValues(object(branch), field));
    // One unconstrained alternative prevents a finite union from proving a field bound.
    if (branchBounds.every((bound) => bound !== null)) {
      bounds.push(new Set(branchBounds.flatMap((bound) => [...bound])));
    }
  }
  const first = bounds[0];
  if (!first) return null;
  return new Set([...first].filter((value) => bounds.every((bound) => bound.has(value))));
}

/** SMS registration omits documented local-only rules; it never replaces local validation. */
export function projectSmsRegistrationSchema(value: unknown): Schema {
  const canonical = object(value);
  checkKeys(canonical, ROOT_KEYS);
  const definitions = object(canonical.definitions);
  checkKeys(definitions, new Set(["types", "events"]));
  for (const type of Object.values(object(definitions.types))) checkKnownRules(type);
  const events = object(definitions.events);
  const references = canonical.oneOf;
  if (
    !Array.isArray(references) ||
    references.length !== Object.keys(events).length ||
    !references.every((value) => {
      const reference = object(value);
      return (
        Object.keys(reference).length === 1 &&
        typeof reference.$ref === "string" &&
        Object.keys(events).some((name) => reference.$ref === "#/definitions/events/" + name)
      );
    }) ||
    new Set(references.map((reference) => object(reference).$ref)).size !== references.length
  ) {
    throw new Error("Every SMS event must have one top-level reference.");
  }
  const projected = Object.fromEntries(
    Object.entries(events).map(([name, value]) => {
      const event = object(value);
      checkKeys(event, EVENT_KEYS);
      checkKnownRules(event);
      const metadata = object(event.eventMeta);
      const projectedObject = projectObject(event);
      const properties = object(projectedObject.properties);
      for (const [field, value] of Object.entries(properties)) {
        const property = object(value);
        const configurationValue = name === "nemoclaw_configuration_observed" && field === "value";
        if (
          property.type !== "string" ||
          Object.hasOwn(property, "enum") ||
          (Object.hasOwn(property, "pattern") && !configurationValue)
        )
          continue;
        const bound = finiteStringValues(event, field);
        if (!bound && configurationValue) {
          throw new Error("Configuration observation values require a finite public bound.");
        }
        if (bound) {
          if (bound.size === 0) throw new Error("A field has no allowed string values.");
          property.enum = [...bound];
        }
      }
      return [
        name,
        {
          eventMeta: structuredClone(metadata),
          description: event.description,
          type: "object",
          additionalProperties: false,
          ...projectedObject,
        },
      ];
    }),
  );
  return {
    $schema: canonical.$schema,
    $comment: canonical.$comment,
    schemaMeta: structuredClone(object(canonical.schemaMeta)),
    description: canonical.description,
    oneOf: structuredClone(references),
    definitions: { types: {}, events: projected },
  };
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(path.resolve(invoked)).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("Expected no arguments or --check.");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const canonicalPath = path.join(root, "schemas/nemoclaw-telemetry.schema.json");
  const outputPath = path.join(root, "schemas/nemoclaw-telemetry-sms.schema.json");
  const canonical: unknown = JSON.parse(readFileSync(canonicalPath, "utf8"));
  const generated = JSON.stringify(projectSmsRegistrationSchema(canonical), null, 2) + "\n";
  if (args.includes("--check")) {
    if (readFileSync(outputPath, "utf8") !== generated) {
      throw new Error("The generated SMS registration schema is stale.");
    }
    console.log("Generated SMS registration schema is current; service acceptance is unverified.");
  } else {
    writeFileSync(outputPath, generated);
    console.log("Generated SMS registration schema; service acceptance is unverified.");
  }
}
