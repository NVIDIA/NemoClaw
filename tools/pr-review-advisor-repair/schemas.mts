// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export const REPAIR_CONTRACT_SCHEMA_FILES = {
  "attempt-receipt": "attempt-receipt.schema.json",
  "proposal-draft": "proposal-draft.schema.json",
  "proposal-receipt": "proposal-receipt.schema.json",
  "publication-receipt": "publication-receipt.schema.json",
  "selection-input": "selection-input.schema.json",
  "validation-receipt": "validation-receipt.schema.json",
} as const;

export type RepairContractSchemaName = keyof typeof REPAIR_CONTRACT_SCHEMA_FILES;

const schemaDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "schemas");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = Object.fromEntries(
  Object.entries(REPAIR_CONTRACT_SCHEMA_FILES).map(([name, fileName]) => [
    name,
    ajv.compile(
      JSON.parse(fs.readFileSync(path.join(schemaDirectory, fileName), "utf8")) as AnySchema,
    ),
  ]),
) as Record<RepairContractSchemaName, ValidateFunction>;

export function repairContractSchemaErrors(
  name: RepairContractSchemaName,
  value: unknown,
): readonly ErrorObject[] | null {
  const validate = validators[name];
  return validate(value) ? null : (validate.errors ?? []);
}
