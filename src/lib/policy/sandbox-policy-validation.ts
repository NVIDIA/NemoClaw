// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv";
import Ajv from "ajv/dist/2020.js";

import { parseOpenShellPolicy } from "./merge";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");
const SANDBOX_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "sandbox-policy.schema.json");
const MAX_SCHEMA_ERRORS = 3;
const MAX_SCHEMA_ERROR_MESSAGE_CHARS = 120;
const MAX_SCHEMA_ERROR_SUMMARY_CHARS = 500;

let cachedSandboxPolicyValidator: ValidateFunction<unknown> | null = null;

function loadSandboxPolicyValidator(): ValidateFunction<unknown> {
  if (cachedSandboxPolicyValidator) return cachedSandboxPolicyValidator;

  let schema: AnySchemaObject;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SANDBOX_POLICY_SCHEMA_PATH, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("schema root is not an object");
    }
    schema = parsed as AnySchemaObject;
  } catch {
    throw new Error(
      "Sandbox policy validation schema is unavailable from this NemoClaw installation.",
    );
  }

  try {
    const compiled = new Ajv({ allErrors: true, strict: false, $data: true }).compile(schema);
    cachedSandboxPolicyValidator = compiled;
    return compiled;
  } catch {
    throw new Error("Sandbox policy schema validation could not be initialized.");
  }
}

function boundedSchemaErrorSummary(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "schema validation failed";

  // AJV's keyword and message describe the trusted schema, not the rejected
  // input value. Deliberately omit instancePath, params, and data so a
  // user-controlled policy key or scalar can never enter rebuild diagnostics.
  const details = errors.slice(0, MAX_SCHEMA_ERRORS).map((error) => {
    const message = (error.message ?? "validation failed")
      .replace(/[\r\n\t]+/gu, " ")
      .slice(0, MAX_SCHEMA_ERROR_MESSAGE_CHARS);
    return `${error.keyword}: ${message}`;
  });
  if (errors.length > MAX_SCHEMA_ERRORS) {
    details.push(`${String(errors.length - MAX_SCHEMA_ERRORS)} more error(s)`);
  }
  return details.join("; ").slice(0, MAX_SCHEMA_ERROR_SUMMARY_CHARS);
}

/** Parse and validate a complete sandbox policy without admitting input values to errors. */
export function parseAndValidateSandboxPolicy(content: string): Record<string, unknown> {
  let policy: Record<string, unknown>;
  try {
    policy = parseOpenShellPolicy(content).policy;
  } catch {
    throw new Error("Sandbox policy is malformed or is not an OpenShell policy YAML mapping.");
  }

  const validate = loadSandboxPolicyValidator();
  if (!validate(policy)) {
    throw new Error(
      `Sandbox policy does not satisfy the shipped sandbox policy schema (${boundedSchemaErrorSummary(validate.errors)}).`,
    );
  }
  return policy;
}
