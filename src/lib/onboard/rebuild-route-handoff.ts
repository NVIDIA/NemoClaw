// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RecordedInferenceRoute } from "./provider-recovery";

export type RegistryInferenceRoute = Readonly<
  Omit<RecordedInferenceRoute, "source"> & {
    source: "registry";
  }
>;

/** Internal, non-persisted route handoff for one destructive rebuild. */
export type RebuildRouteHandoff = Readonly<{
  sandboxName: string;
  route: RegistryInferenceRoute;
}>;

/** Internal, non-persisted authority to upsert one preflighted provider during rebuild. */
export type RebuildProviderReconfigureHandoff = Readonly<{
  sandboxName: string;
  provider: string;
  model: string;
  credentialEnv: string;
  endpointUrl: string | null;
}>;

/**
 * Capture the pre-delete registry route as an immutable, defensive handoff.
 * The runtime source check keeps untyped callers from relabeling session state
 * as registry authority before the destructive rebuild begins.
 */
export function createRebuildRouteHandoff(
  sandboxName: string,
  route: RegistryInferenceRoute,
): RebuildRouteHandoff {
  if (route.source !== "registry") {
    throw new TypeError("Rebuild route handoff requires a registry-derived route");
  }
  const frozenRoute: RegistryInferenceRoute = Object.freeze({
    provider: route.provider,
    model: route.model,
    endpointUrl: route.endpointUrl,
    preferredInferenceApi: route.preferredInferenceApi,
    source: "registry",
  });
  return Object.freeze({ sandboxName, route: frozenRoute });
}

export function createRebuildProviderReconfigureHandoff(
  handoff: RebuildProviderReconfigureHandoff,
): RebuildProviderReconfigureHandoff {
  if (
    !handoff.sandboxName.trim() ||
    !handoff.provider.trim() ||
    !handoff.model.trim() ||
    !handoff.credentialEnv.trim()
  ) {
    throw new TypeError("Rebuild provider reconfigure handoff is incomplete");
  }
  return Object.freeze({ ...handoff });
}

/** Validate that a one-shot provider handoff still belongs to the authoritative resume target. */
export function validateRebuildProviderReconfigureHandoff(
  handoff: RebuildProviderReconfigureHandoff | null | undefined,
  target: RebuildProviderReconfigureHandoff,
): boolean {
  if (!handoff) return false;
  if (
    handoff.sandboxName !== target.sandboxName ||
    handoff.provider !== target.provider ||
    handoff.model !== target.model ||
    handoff.credentialEnv !== target.credentialEnv ||
    handoff.endpointUrl !== target.endpointUrl
  ) {
    throw new Error("Prepared provider reconfiguration does not match the authoritative target.");
  }
  return true;
}
