// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Legacy default retained only for process cleanup and port ownership checks. */
export const DEFAULT_MODEL_ROUTER_PORT = 4000;

/** Recover a pre-routerPort cleanup identity without consulting the current blueprint. */
export function resolveLegacyModelRouterPort(
  session:
    | Record<string, unknown>
    | {
        provider?: unknown;
        routerPid?: unknown;
        routerCredentialHash?: unknown;
        endpointUrl?: unknown;
      },
): number | null {
  const hasRouterIdentity =
    session.provider === "nvidia-router" ||
    (typeof session.routerPid === "number" &&
      Number.isInteger(session.routerPid) &&
      session.routerPid > 0) ||
    (typeof session.routerCredentialHash === "string" && session.routerCredentialHash.length > 0);
  if (!hasRouterIdentity || typeof session.endpointUrl !== "string") return null;
  try {
    const endpoint = new URL(session.endpointUrl);
    const port = endpoint.port ? Number(endpoint.port) : null;
    return endpoint.protocol === "http:" &&
      endpoint.hostname === "host.openshell.internal" &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      port !== null &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
      ? port
      : null;
  } catch {
    return null;
  }
}
