// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import cuaLifecycleSchema from "../../../schemas/cua-lifecycle.schema.json";
import cuaTargetManifestSchema from "../../../schemas/cua-target-manifest.schema.json";
import {
  CUA_CAPABILITIES,
  type CuaCapabilityIdentity,
  type CuaComponentIdentity,
  type CuaRuntimeReadiness,
  getCuaComponentIdentityErrors,
  getCuaCoordinateFreeSelectorErrors,
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

export function parseCuaLifecycleRecord(value: unknown): CuaRuntimeReadiness {
  const record = parseWithSchema<CuaRuntimeReadiness>(
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
  return parseCuaLifecycleRecord(value);
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
  const identityErrors = [
    ...getCuaCoordinateFreeSelectorErrors(manifest.platform, "platform"),
    ...getCuaComponentIdentityErrors(manifest.image, "image"),
    ...getCuaComponentIdentityErrors(manifest.serviceBundle, "serviceBundle"),
  ];
  if (identityErrors.length > 0) {
    throw new Error(`CUA target manifest violates its contract: ${identityErrors.join("; ")}`);
  }
  return manifest;
}
