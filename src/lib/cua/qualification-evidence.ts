// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const RAW_DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export interface CuaQualificationEnvironment {
  schemaVersion: "1.0.0";
  kind: "cua-candidate-environment";
  nemoclawCommit: string;
  bundleReceiptSha256: string;
  runtimeManifestSha256: string;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("CUA candidate environment must be an object");
  }
  return value as Record<string, unknown>;
}

/** Parse the narrow, content-free candidate installation authority. */
export function parseCuaQualificationEnvironment(value: unknown): CuaQualificationEnvironment {
  const record = object(value);
  const expected = [
    "bundleReceiptSha256",
    "kind",
    "nemoclawCommit",
    "runtimeManifestSha256",
    "schemaVersion",
  ];
  if (Object.keys(record).sort().join("\0") !== expected.join("\0")) {
    throw new Error(`CUA candidate environment must contain exactly: ${expected.join(", ")}`);
  }
  if (
    record.schemaVersion !== "1.0.0" ||
    record.kind !== "cua-candidate-environment" ||
    typeof record.nemoclawCommit !== "string" ||
    !COMMIT.test(record.nemoclawCommit) ||
    typeof record.bundleReceiptSha256 !== "string" ||
    !RAW_DIGEST.test(record.bundleReceiptSha256) ||
    typeof record.runtimeManifestSha256 !== "string" ||
    !RAW_DIGEST.test(record.runtimeManifestSha256)
  ) {
    throw new Error("CUA candidate environment has an invalid identity");
  }
  return structuredClone(record) as unknown as CuaQualificationEnvironment;
}
