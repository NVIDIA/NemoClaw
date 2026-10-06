// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv, { type AnySchema } from "ajv";
import assert from "node:assert/strict";
import telemetrySchema from "../../../../schemas/nemoclaw-telemetry.schema.json";
import smsRegistrationSchema from "../../../../schemas/nemoclaw-telemetry-sms.schema.json";
import type { TelemetryEvent } from "../../domain/telemetry/event";

function schemaValidator(composedOnly = false) {
  const validator = new Ajv({ allErrors: false, strict: false });
  validator.addFormat("date-time", (value: string) => {
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
  });
  const schema = composedOnly
    ? {
        ...telemetrySchema,
        definitions: {
          ...telemetrySchema.definitions,
          events: Object.fromEntries(
            Object.entries(telemetrySchema.definitions.events).map(([name, event]) => [
              name,
              { allOf: event.allOf },
            ]),
          ),
        },
      }
    : telemetrySchema;
  return validator.compile(schema as AnySchema);
}

export function acceptsTelemetryParameters(value: unknown): boolean {
  const accepted = Boolean(schemaValidator()(value));
  // The direct local field inventory must not change the existing composed contract.
  assert.equal(accepted, Boolean(schemaValidator(true)(value)));
  if (accepted) assert.equal(acceptsSmsRegistrationParameters(value), true);
  return accepted;
}

export function acceptsFamilyParameters(
  name: TelemetryEvent["event"],
  parameters: unknown,
): boolean {
  const validator = new Ajv({ allErrors: false, strict: false });
  validator.addFormat("date-time", (value: string) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  });
  const schema = {
    $schema: telemetrySchema.$schema,
    $ref: `#/definitions/events/${name}`,
    definitions: telemetrySchema.definitions,
  };
  const accepted = Boolean(validator.compile(schema as AnySchema)(parameters));
  const composedSchema = {
    $schema: telemetrySchema.$schema,
    definitions: telemetrySchema.definitions,
    allOf: telemetrySchema.definitions.events[name].allOf,
  };
  assert.equal(Boolean(validator.compile(composedSchema as AnySchema)(parameters)), accepted);
  if (accepted) assert.equal(acceptsSmsRegistrationParameters(parameters, name), true);
  return accepted;
}

export function acceptsSmsRegistrationParameters(value: unknown, name?: string): boolean {
  const schema = name
    ? {
        $schema: smsRegistrationSchema.$schema,
        $ref: `#/definitions/events/${name}`,
        definitions: smsRegistrationSchema.definitions,
      }
    : smsRegistrationSchema;
  return Boolean(new Ajv({ allErrors: false, strict: false }).compile(schema as AnySchema)(value));
}

export function hasCompatibleTelemetryMetadata(
  payload: { clientId: unknown; eventSchemaVer: unknown } | null,
): boolean {
  return (
    payload !== null &&
    telemetrySchema.schemaMeta.clientId === payload.clientId &&
    telemetrySchema.schemaMeta.schemaVersion === payload.eventSchemaVer &&
    telemetrySchema.schemaMeta.definitionVersion === "2.0" &&
    telemetrySchema.schemaMeta.personalization === "anonymous"
  );
}
