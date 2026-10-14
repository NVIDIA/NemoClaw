// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import { dockerContextIsDefaultFromBuild } from "../../adapters/docker/client-isolation";
import { dockerRun } from "../../adapters/docker/run";
import {
  parseRetainedSandboxCreateAuthority,
  type RetainedSandboxCreateAuthority,
} from "../../state/onboard-session/retained-sandbox-recovery";
import { resolveGatewayStateDirForPort } from "../gateway/state-dir";
import { resolveOwnedHostGatewayRuntimeProviderId } from "../host-gateway-process";

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
    ...(boundary.openshellGatewayStateDir
      ? { openshellGatewayStateDir: boundary.openshellGatewayStateDir }
      : {}),
    sandboxName: boundary.sandboxName,
    lifecycleGeneration: boundary.lifecycleGeneration,
    sandboxIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
    ...(boundary.createAttemptNonce ? { createAttemptNonce: boundary.createAttemptNonce } : {}),
    ...(boundary.managedBootstrapIdentity
      ? { managedBootstrapIdentity: boundary.managedBootstrapIdentity }
      : {}),
    route: boundary.route,
  };
  if (!prior) return identity;
  const {
    managedBootstrapIdentity: priorManagedBootstrapIdentity,
    exactFinalHandoffCommitStarted,
    exactFinalHandoffRuntimeId,
    exactFinalHandoffAcknowledged,
    ...priorIdentity
  } = prior;
  const { managedBootstrapIdentity, ...identityBeforeManagedBootstrap } = identity;
  if (
    !isDeepStrictEqual(priorIdentity, identityBeforeManagedBootstrap) ||
    (priorManagedBootstrapIdentity !== undefined &&
      priorManagedBootstrapIdentity !== managedBootstrapIdentity)
  ) {
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
    ...(identity.openshellGatewayStateDir
      ? { openshellGatewayStateDir: identity.openshellGatewayStateDir }
      : {}),
    lifecycleGeneration: identity.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: identity.sandboxIdentityFingerprint,
    ...(identity.createAttemptNonce ? { createAttemptNonce: identity.createAttemptNonce } : {}),
    ...(identity.managedBootstrapIdentity
      ? { managedBootstrapIdentity: identity.managedBootstrapIdentity }
      : {}),
    route: identity.route,
  };
}

/** Bind recovery to the daemon used by the owned native gateway before sending create. */
export function captureNativeDockerRecoveryAuthority(
  gatewayName: string,
  gatewayPort: number,
  reservationSessionId: string,
): RetainedSandboxCreateAuthority | undefined {
  if (process.platform !== "linux") return undefined;
  if (
    process.env.DOCKER_HOST?.trim() !== "unix:///var/run/docker.sock" &&
    !dockerContextIsDefaultFromBuild(process.env)
  )
    return undefined;
  const gatewayStateDir = resolveGatewayStateDirForPort({
    configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    home: os.homedir(),
    port: gatewayPort,
  });
  const ownedRuntime = () =>
    resolveOwnedHostGatewayRuntimeProviderId({
      gatewayName,
      gatewayPort,
      stateDir: gatewayStateDir,
      requireDefaultDockerDaemon: true,
    });
  if (ownedRuntime() !== "docker") return undefined;
  const result = dockerRun(["--context", "default", "info", "--format", "{{.ID}}"], {
    ignoreError: true,
    suppressOutput: true,
    timeout: 5_000,
  });
  const authority = parseRetainedSandboxCreateAuthority({
    schemaVersion: 1,
    runtime: "native-linux-default-docker",
    reservationSessionId,
    gatewayStateDir,
    daemonId: String(result.stdout ?? "").trim(),
  });
  if (
    result.status !== 0 ||
    String(result.stderr ?? "").trim() ||
    !authority ||
    ownedRuntime() !== "docker"
  ) {
    throw new Error("Cannot establish the owned Docker daemon for retained create recovery.");
  }
  return authority;
}
