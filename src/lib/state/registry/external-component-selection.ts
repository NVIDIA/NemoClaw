// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxExternalComponentSelection } from "./types";

const COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

export function parseSandboxExternalComponentSelection(
  value: unknown,
): SandboxExternalComponentSelection | null {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !record ||
    Object.keys(record).length !== 5 ||
    record.schemaVersion !== 1 ||
    typeof record.componentId !== "string" ||
    !COMPONENT_ID.test(record.componentId) ||
    typeof record.gatewayName !== "string" ||
    !record.gatewayName ||
    typeof record.lifecycleGeneration !== "string" ||
    !record.lifecycleGeneration ||
    typeof record.sandboxIdentityFingerprint !== "string" ||
    !FINGERPRINT.test(record.sandboxIdentityFingerprint)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    componentId: record.componentId,
    gatewayName: record.gatewayName,
    lifecycleGeneration: record.lifecycleGeneration,
    sandboxIdentityFingerprint: record.sandboxIdentityFingerprint,
  };
}
