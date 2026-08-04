// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SUPPORTED_SYSTEM_READINESS_SCHEMA_MAJOR } from "./types.js";

export type SchemaCompatibility =
  | { compatible: true; major: number }
  | { compatible: false; major: number | null; reason: string };

export function checkSystemReadinessSchemaVersion(schemaVersion: unknown): SchemaCompatibility {
  if (typeof schemaVersion !== "string") {
    return { compatible: false, major: null, reason: "schemaVersion must be a string" };
  }

  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(schemaVersion);
  if (!match) {
    return { compatible: false, major: null, reason: "schemaVersion must use major.minor.patch" };
  }

  const major = Number(match[1]);
  if (major !== SUPPORTED_SYSTEM_READINESS_SCHEMA_MAJOR) {
    return {
      compatible: false,
      major,
      reason: `unsupported system readiness schema major ${major}`,
    };
  }

  return { compatible: true, major };
}
