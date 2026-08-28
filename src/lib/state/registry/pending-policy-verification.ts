// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseNemoClawPolicyCreationReceipt } from "../../policy/merge";
import type { PendingSandboxPolicyVerification } from "./types";

const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PENDING_POLICY_VERIFICATION_KEYS = new Set([
  "schemaVersion",
  "state",
  "policyAuthority",
  "observedPolicyAuthority",
  "gatewayName",
  "gatewayPort",
  "sandboxName",
  "lifecycleGeneration",
  "sandboxIdentityFingerprint",
  "route",
  "policyHash",
  "policyVersion",
  "policyCreationReceipt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clone one exact post-create policy checkpoint and reject partial or forged state. */
export function normalizePendingSandboxPolicyVerification(
  value: unknown,
): PendingSandboxPolicyVerification | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !PENDING_POLICY_VERIFICATION_KEYS.has(key)) ||
    value.schemaVersion !== 1 ||
    value.state !== "verified-create" ||
    (value.policyAuthority !== "nemoclaw-managed" &&
      value.policyAuthority !== "externally-managed") ||
    (value.observedPolicyAuthority !== "owner-unknown" &&
      value.observedPolicyAuthority !== "externally-managed") ||
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
    (value.route !== "none" && value.route !== "native" && value.route !== "compatibility") ||
    typeof value.policyHash !== "string" ||
    !Number.isSafeInteger(value.policyVersion) ||
    Number(value.policyVersion) < 1
  ) {
    throw new Error(
      "Sandbox registry contains an invalid pending policy verification; repair the registry before continuing",
    );
  }
  let boundary;
  try {
    boundary = parseNemoClawPolicyCreationReceipt({
      schemaVersion: 1,
      origin: "sandbox-create",
      gatewayName: value.gatewayName,
      gatewayPort: value.gatewayPort,
      sandboxName: value.sandboxName,
      lifecycleGeneration: value.lifecycleGeneration,
      sandboxIdentityFingerprint: value.sandboxIdentityFingerprint,
      policyHash: value.policyHash,
      policyVersion: value.policyVersion,
    });
  } catch {
    throw new Error(
      "Sandbox registry contains an invalid pending policy verification identity; repair the registry before continuing",
    );
  }
  if (value.policyAuthority === "nemoclaw-managed") {
    if (value.observedPolicyAuthority !== "owner-unknown") {
      throw new Error(
        "Sandbox registry contains an invalid managed pending policy verification; repair the registry before continuing",
      );
    }
    let receipt;
    try {
      receipt = parseNemoClawPolicyCreationReceipt(value.policyCreationReceipt);
    } catch {
      throw new Error(
        "Sandbox registry contains an invalid policy creation receipt; repair the registry before continuing",
      );
    }
    if (
      receipt.gatewayName !== boundary.gatewayName ||
      receipt.gatewayPort !== boundary.gatewayPort ||
      receipt.sandboxName !== boundary.sandboxName ||
      receipt.lifecycleGeneration !== boundary.lifecycleGeneration ||
      receipt.sandboxIdentityFingerprint !== boundary.sandboxIdentityFingerprint ||
      receipt.policyHash !== boundary.policyHash ||
      receipt.policyVersion !== boundary.policyVersion
    ) {
      throw new Error(
        "Sandbox registry pending managed policy verification does not match its creation receipt",
      );
    }
    return {
      schemaVersion: 1,
      state: "verified-create",
      policyAuthority: "nemoclaw-managed",
      observedPolicyAuthority: "owner-unknown",
      gatewayName: boundary.gatewayName,
      gatewayPort: boundary.gatewayPort,
      sandboxName: boundary.sandboxName,
      lifecycleGeneration: boundary.lifecycleGeneration,
      sandboxIdentityFingerprint: boundary.sandboxIdentityFingerprint,
      route: value.route,
      policyHash: boundary.policyHash,
      policyVersion: boundary.policyVersion,
      policyCreationReceipt: receipt,
    };
  }
  if (value.policyCreationReceipt !== undefined) {
    throw new Error(
      "Sandbox registry pending external policy verification cannot contain a creation receipt",
    );
  }
  return {
    schemaVersion: 1,
    state: "verified-create",
    policyAuthority: "externally-managed",
    observedPolicyAuthority: value.observedPolicyAuthority,
    gatewayName: boundary.gatewayName,
    gatewayPort: boundary.gatewayPort,
    sandboxName: boundary.sandboxName,
    lifecycleGeneration: boundary.lifecycleGeneration,
    sandboxIdentityFingerprint: boundary.sandboxIdentityFingerprint,
    route: value.route,
    policyHash: boundary.policyHash,
    policyVersion: boundary.policyVersion,
  };
}
