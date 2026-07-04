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
