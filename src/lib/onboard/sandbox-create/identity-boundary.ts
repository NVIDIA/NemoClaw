// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { DockerSandboxIdentityObservation } from "../../adapters/docker/inspect";
import { normalizePendingSandboxCreateIdentity } from "../../state/registry-normalization";
import type { PendingSandboxCreateIdentity } from "../../state/registry/types";
import { fullDockerContainerId } from "../docker-gpu-patch-clone";
import {
  inspectDockerSandboxNameLabeledContainers,
  OPENSHELL_MANAGED_BY_VALUE,
} from "../openshell-docker-sandbox-containers";
import { fingerprintSandboxRecreateValue } from "../sandbox-recreate-transaction";
import type { VerifiedSandboxCreateBoundary } from "../types";

/** Recover one exact Docker runtime from immutable legacy identity evidence. */
export function resolveLegacyCompatibilityFinalHandoffRuntime(input: {
  readonly checkpoint: PendingSandboxCreateIdentity;
  readonly observation?: DockerSandboxIdentityObservation;
}): string {
  const observation =
    input.observation ?? inspectDockerSandboxNameLabeledContainers(input.checkpoint.sandboxName);
  if (
    observation.status !== "observed" ||
    observation.malformedRows !== 0 ||
    observation.rows.length !== 1
  ) {
    throw new Error(
      "Legacy compatibility recovery could not prove one exact Docker replacement runtime.",
    );
  }
  const [row] = observation.rows;
  const runtimeId = fullDockerContainerId(row?.id);
  if (
    !runtimeId ||
    row?.managedBy !== OPENSHELL_MANAGED_BY_VALUE ||
    !row.sandboxId ||
    fingerprintSandboxRecreateValue(row.sandboxId) !== input.checkpoint.sandboxIdentityFingerprint
  ) {
    throw new Error(
      "Legacy compatibility recovery Docker identity does not match its durable sandbox checkpoint.",
    );
  }
  return runtimeId;
}

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
  const {
    exactFinalHandoffCommitStarted,
    exactFinalHandoffRuntimeId,
    exactFinalHandoffAcknowledged,
    ...priorIdentity
  } = prior;
  if (!isDeepStrictEqual(priorIdentity, identity)) {
    throw new Error("Final-handoff receipt does not match the verified create boundary.");
  }
  return {
    ...identity,
    ...(exactFinalHandoffCommitStarted ? { exactFinalHandoffCommitStarted } : {}),
    ...(exactFinalHandoffRuntimeId ? { exactFinalHandoffRuntimeId } : {}),
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
