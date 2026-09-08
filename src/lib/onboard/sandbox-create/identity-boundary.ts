// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { normalizePendingSandboxCreateIdentity } from "../../state/registry-normalization";
import type { PendingSandboxCreateIdentity } from "../../state/registry/types";
import type { VerifiedSandboxCreateBoundary } from "../types";

/** Flatten one create boundary into its bounded incomplete-create identity. */
export function pendingSandboxCreateIdentityForBoundary(
  boundary: VerifiedSandboxCreateBoundary,
  prior?: PendingSandboxCreateIdentity | null,
): PendingSandboxCreateIdentity {
  const identity: PendingSandboxCreateIdentity = {
    schemaVersion: 1,
    state: "verified-create",
    gatewayName: boundary.gatewayName,
    gatewayPort: boundary.gatewayPort,
    sandboxName: boundary.sandboxName,
    lifecycleGeneration: boundary.lifecycleGeneration,
    sandboxIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
    ...(boundary.createAttemptNonce ? { createAttemptNonce: boundary.createAttemptNonce } : {}),
    route: boundary.route,
  };
  if (!prior) return identity;
  const { exactFinalHandoffCommitStarted, exactFinalHandoffAcknowledged, ...priorIdentity } = prior;
  if (!isDeepStrictEqual(priorIdentity, identity)) {
    throw new Error("Final-handoff receipt does not match the verified create boundary.");
  }
  return {
    ...identity,
    ...(exactFinalHandoffCommitStarted ? { exactFinalHandoffCommitStarted } : {}),
    ...(exactFinalHandoffAcknowledged ? { exactFinalHandoffAcknowledged } : {}),
  };
}

/** Restore the process-local create boundary from one bounded identity. */
export function sandboxCreateBoundaryFromPendingIdentity(
  value: unknown,
): VerifiedSandboxCreateBoundary {
  const identity = normalizePendingSandboxCreateIdentity(value);
  if (!identity) throw new Error("Pending sandbox create identity is unavailable.");
  return {
    sandboxName: identity.sandboxName,
    gatewayName: identity.gatewayName,
    gatewayPort: identity.gatewayPort,
    lifecycleGeneration: identity.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: identity.sandboxIdentityFingerprint,
    ...(identity.createAttemptNonce ? { createAttemptNonce: identity.createAttemptNonce } : {}),
    route: identity.route,
  };
}
