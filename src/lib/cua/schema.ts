// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import cuaLifecycleSchema from "../../../schemas/cua-lifecycle.schema.json";
import cuaTargetManifestSchema from "../../../schemas/cua-target-manifest.schema.json";
import {
  CUA_CAPABILITIES,
  type CuaCapabilityIdentity,
  type CuaComponentIdentity,
  type CuaLifecycleRecord,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  type CuaTaskEvidenceIndex,
  type CuaTaskResult,
  getCuaLifecycleSemanticErrors,
} from "./contract";

export interface CuaTargetManifest {
  schemaVersion: string;
  kind: "target-manifest";
  identityDigest: string;
  platform: string;
  image: CuaComponentIdentity;
  serviceBundle: CuaComponentIdentity;
  capabilities: readonly CuaCapabilityIdentity[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateLifecycle = ajv.compile(cuaLifecycleSchema as AnySchema);
const validateTargetManifest = ajv.compile(cuaTargetManifestSchema as AnySchema);

function schemaErrorPaths(errors: ErrorObject[] | null | undefined): string {
  const paths = (errors ?? []).map((error) => error.instancePath || "$");
  return [...new Set(paths)].sort().join(", ") || "$";
}

function parseWithSchema<T>(value: unknown, validate: ValidateFunction, label: string): T {
  if (!validate(value)) {
    throw new Error(`${label} does not match its schema at ${schemaErrorPaths(validate.errors)}`);
  }
  return structuredClone(value) as T;
}

export function parseCuaLifecycleRecord(value: unknown): CuaLifecycleRecord {
  const record = parseWithSchema<CuaLifecycleRecord>(
    value,
    validateLifecycle,
    "CUA lifecycle record",
  );
  const semanticErrors = getCuaLifecycleSemanticErrors(record);
  if (semanticErrors.length > 0) {
    throw new Error(`CUA lifecycle record violates its contract: ${semanticErrors.join("; ")}`);
  }
  return record;
}

export function parseCuaRuntimeReadiness(value: unknown): CuaRuntimeReadiness {
  const record = parseCuaLifecycleRecord(value);
  if (record.kind !== "runtime-readiness") {
    throw new Error("CUA runtime state must be a runtime-readiness record");
  }
  return record;
}

export function parseCuaTargetAttachment(value: unknown): CuaTargetAttachment {
  const record = parseCuaLifecycleRecord(value);
  if (record.kind !== "target-attachment") {
    throw new Error("CUA target state must be a target-attachment record");
  }
  return record;
}

export function parseCuaSecurityAttestation(value: unknown): CuaSecurityAttestation {
  const record = parseCuaLifecycleRecord(value);
  if (record.kind !== "security-attestation") {
    throw new Error("CUA security state must be a security-attestation record");
  }
  return record;
}

export function parseCuaTaskEvidenceIndex(value: unknown): CuaTaskEvidenceIndex {
  const record = parseCuaLifecycleRecord(value);
  if (record.kind !== "task-evidence-index") {
    throw new Error("CUA task evidence state must be a task-evidence-index record");
  }
  return record;
}

export function parseCuaTaskResult(value: unknown): CuaTaskResult {
  const record = parseCuaLifecycleRecord(value);
  if (record.kind !== "task-result") {
    throw new Error("CUA task result state must be a task-result record");
  }
  return record;
}

export function parseCuaTargetManifest(value: unknown): CuaTargetManifest {
  const manifest = parseWithSchema<CuaTargetManifest>(
    value,
    validateTargetManifest,
    "CUA target manifest",
  );
  const capabilityIds = manifest.capabilities.map((capability) => capability.id);
  const expected = new Set(CUA_CAPABILITIES);
  if (
    new Set(capabilityIds).size !== CUA_CAPABILITIES.length ||
    capabilityIds.some((capability) => !expected.has(capability))
  ) {
    throw new Error("CUA target manifest must declare browser, computer, and terminal once");
  }
  return manifest;
}
