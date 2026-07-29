// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  type ManagedGatewayRuntimeBinding,
  readManagedGatewayRuntimeBinding,
} from "../../../onboard/docker-driver-gateway-config";

export interface ResolvePodmanRuntimeSocketDeps {
  readRuntimeBinding?: (stateDir: string) => ManagedGatewayRuntimeBinding | null;
}

function requireAbsoluteSocketPath(socketPath: string, source: string): string {
  const normalized = socketPath.trim();
  if (!normalized || !path.isAbsolute(normalized)) {
    throw new Error(`${source} must contain an absolute Podman socket path.`);
  }
  return normalized;
}

/**
 * Resolve the exact socket bound to a Podman-backed managed gateway.
 *
 * An explicit environment override remains useful for recovery, but fresh
 * lifecycle commands normally recover the value from the protected,
 * config-bound runtime sidecar written during onboarding.
 */
export function resolvePodmanRuntimeSocket(
  stateDir: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  deps: ResolvePodmanRuntimeSocketDeps = {},
): string {
  if (!stateDir) {
    throw new Error("Podman runtime socket recovery requires a managed gateway state directory.");
  }

  const binding = (deps.readRuntimeBinding ?? readManagedGatewayRuntimeBinding)(stateDir);
  if (!binding) {
    throw new Error(`Managed runtime binding is missing in '${stateDir}'.`);
  }
  if (binding.driverName !== "podman") {
    throw new Error(
      `Managed runtime binding in '${stateDir}' declares driver '${binding.driverName}', not 'podman'.`,
    );
  }
  const socketPath = binding.values.socket_path;
  if (typeof socketPath !== "string") {
    throw new Error(`Managed Podman runtime binding in '${stateDir}' has no string socket_path.`);
  }
  const persisted = requireAbsoluteSocketPath(
    socketPath,
    `Managed Podman runtime binding in '${stateDir}'`,
  );
  const explicit = environment.OPENSHELL_PODMAN_SOCKET?.trim();
  if (explicit) {
    const requested = requireAbsoluteSocketPath(explicit, "OPENSHELL_PODMAN_SOCKET");
    if (requested !== persisted) {
      throw new Error(
        `OPENSHELL_PODMAN_SOCKET does not match the managed Podman runtime binding in '${stateDir}'.`,
      );
    }
  }
  return persisted;
}
