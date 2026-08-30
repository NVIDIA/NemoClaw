// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PendingSandboxCreateIdentity } from "./types";

const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const KEYS = new Set([
  "gatewayName",
  "gatewayPort",
  "lifecycleGeneration",
  "createAttemptNonce",
  "route",
  "sandboxIdentityFingerprint",
  "sandboxName",
  "schemaVersion",
  "state",
]);
const LEGACY_POLICY_KEYS = new Set([
  "observedPolicyAuthority",
  "policyAuthority",
  "policyCreationReceipt",
  "policyHash",
  "policyVersion",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize the bounded identity checkpoint for one incomplete create. */
export function normalizePendingSandboxCreateIdentity(
  value: unknown,
): PendingSandboxCreateIdentity | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !KEYS.has(key) && !LEGACY_POLICY_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    value.state !== "verified-create" ||
    typeof value.gatewayName !== "string" ||
    value.gatewayName.length === 0 ||
    !Number.isSafeInteger(value.gatewayPort) ||
    Number(value.gatewayPort) < 1 ||
    Number(value.gatewayPort) > 65_535 ||
    typeof value.sandboxName !== "string" ||
    value.sandboxName.length === 0 ||
    typeof value.lifecycleGeneration !== "string" ||
    value.lifecycleGeneration.length === 0 ||
    typeof value.sandboxIdentityFingerprint !== "string" ||
    !SHA256_DIGEST_PATTERN.test(value.sandboxIdentityFingerprint) ||
    (value.createAttemptNonce !== undefined &&
      (typeof value.createAttemptNonce !== "string" ||
        !/^[0-9a-f]{62}$/u.test(value.createAttemptNonce))) ||
    (value.route !== "none" && value.route !== "native" && value.route !== "compatibility")
  ) {
    throw new Error(
      "Sandbox registry contains an invalid pending sandbox create verification; repair the registry before continuing",
    );
  }
  return {
    schemaVersion: 1,
    state: "verified-create",
    gatewayName: value.gatewayName,
    gatewayPort: Number(value.gatewayPort),
    sandboxName: value.sandboxName,
    lifecycleGeneration: value.lifecycleGeneration,
    sandboxIdentityFingerprint: value.sandboxIdentityFingerprint,
    ...(value.createAttemptNonce ? { createAttemptNonce: value.createAttemptNonce } : {}),
    route: value.route,
  };
}
