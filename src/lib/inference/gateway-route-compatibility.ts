// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalEndpoint, type EndpointFlavor } from "../core/url-utils";
import { resolveSandboxGatewayName } from "../onboard/gateway-binding";
import type { SandboxEntry } from "../state/registry";

export type GatewayInferenceRoute = Pick<
  SandboxEntry,
  "provider" | "model" | "endpointUrl" | "preferredInferenceApi" | "credentialEnv"
>;

export interface GatewayRouteCompatibilityRequest {
  gatewayName: string;
  sandboxName: string | null;
  route: GatewayInferenceRoute;
  sandboxes: readonly SandboxEntry[];
}

export type CurrentGatewayRouteCompatibilityRequest = Pick<
  GatewayRouteCompatibilityRequest,
  "gatewayName" | "sandboxName" | "route"
>;

export type CurrentGatewayRouteCompatibilityCheck = (
  request: CurrentGatewayRouteCompatibilityRequest,
) => GatewayRouteCompatibilityResult;

export type GatewayRouteConflictReason =
  | "provider-model"
  | "custom-endpoint"
  | "custom-api"
  | "incomplete-route"
  | "incomplete-custom-route"
  | "invalid-gateway-binding";

export interface GatewayRouteConflict {
  sandboxName: string;
  reason: GatewayRouteConflictReason;
  scope?: "requested" | "registered";
}

export type GatewayRouteCompatibilityResult =
  | { ok: true }
  | {
      ok: false;
      gatewayName: string;
      sandboxName: string | null;
      route: { provider: string; model: string };
      conflicts: GatewayRouteConflict[];
    };

export interface GatewayRouteDiscoveryConstraints {
  requiredModel: string | null;
  requiredEndpointUrl: string | null;
  requiredInferenceApi: string | null;
}

export type GatewayRouteDiscoveryResult =
  | ({ ok: true } & GatewayRouteDiscoveryConstraints)
  | { ok: false; result: Exclude<GatewayRouteCompatibilityResult, { ok: true }> };

export type CurrentGatewayRouteDiscoveryPreflight = (
  request: Omit<CurrentGatewayRouteCompatibilityRequest, "route"> & {
    route: Omit<GatewayInferenceRoute, "model"> & { model: string | null };
  },
) => GatewayRouteDiscoveryResult;

const CUSTOM_ROUTE_PROVIDERS = new Set(["compatible-endpoint", "compatible-anthropic-endpoint"]);

const SUPPORTED_INFERENCE_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]);

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function configuredRoute(route: GatewayInferenceRoute): { provider: string; model: string } | null {
  const provider = nonEmptyString(route.provider);
  const model = nonEmptyString(route.model);
  return provider && model ? { provider, model } : null;
}

function endpointFlavor(provider: string): EndpointFlavor {
  return provider === "compatible-anthropic-endpoint" ? "anthropic" : "openai";
}

function normalizedInferenceApi(value: unknown): string | null {
  const api = nonEmptyString(value);
  return api && SUPPORTED_INFERENCE_APIS.has(api) ? api : null;
}

function customRouteConflict(
  provider: string,
  requested: GatewayInferenceRoute,
  recorded: GatewayInferenceRoute,
): GatewayRouteConflictReason | null {
  const flavor = endpointFlavor(provider);
  const requestedEndpoint = canonicalEndpoint(requested.endpointUrl, flavor);
  const recordedEndpoint = canonicalEndpoint(recorded.endpointUrl, flavor);
  const requestedApi = normalizedInferenceApi(requested.preferredInferenceApi);
  const recordedApi = normalizedInferenceApi(recorded.preferredInferenceApi);
  if (!requestedEndpoint || !recordedEndpoint || !requestedApi || !recordedApi) {
    return "incomplete-custom-route";
  }
  if (requestedEndpoint !== recordedEndpoint) return "custom-endpoint";
  if (requestedApi !== recordedApi) return "custom-api";
  return null;
}

/**
 * Constrain read-only route discovery from durable same-gateway registry peers.
 * Missing requested model/API fields are allowed only when the gateway has no
 * configured peer, or when every peer supplies one identical value that
 * discovery must subsequently verify with the exact compatibility guard.
 */
export function preflightGatewayRouteDiscovery(
  request: Parameters<CurrentGatewayRouteDiscoveryPreflight>[0] & {
    sandboxes: readonly SandboxEntry[];
  },
): GatewayRouteDiscoveryResult {
  const provider = nonEmptyString(request.route.provider);
  if (!provider) throw new Error("Requested gateway inference route requires a provider");
  const peers: SandboxEntry[] = [];
  const discoveryConflicts: GatewayRouteConflict[] = [];
  for (const sandbox of request.sandboxes) {
    if (sandbox.name === request.sandboxName) continue;
    let recordedGatewayName: string;
    try {
      recordedGatewayName = resolveSandboxGatewayName(sandbox);
    } catch {
      discoveryConflicts.push({
        sandboxName: sandbox.name,
        reason: "invalid-gateway-binding",
        scope: "registered",
      });
      continue;
    }
    if (recordedGatewayName !== request.gatewayName) continue;
    if (configuredRoute(sandbox)) peers.push(sandbox);
    else {
      discoveryConflicts.push({
        sandboxName: sandbox.name,
        reason: "incomplete-route",
        scope: "registered",
      });
    }
  }
  const requestedModel = nonEmptyString(request.route.model);
  if (discoveryConflicts.length > 0) {
    return {
      ok: false,
      result: {
        ok: false,
        gatewayName: request.gatewayName,
        sandboxName: request.sandboxName,
        route: { provider, model: requestedModel ?? "model discovery pending" },
        conflicts: discoveryConflicts,
      },
    };
  }
  if (peers.length === 0) {
    return {
      ok: true,
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    };
  }
  const reference = peers[0];
  const recorded = configuredRoute(reference);
  if (!recorded) throw new Error("Gateway route discovery peer is not configured");
  if (provider !== recorded.provider || (requestedModel && requestedModel !== recorded.model)) {
    return {
      ok: false,
      result: {
        ok: false,
        gatewayName: request.gatewayName,
        sandboxName: request.sandboxName,
        route: { provider, model: requestedModel ?? recorded.model },
        conflicts: peers.map((sandbox) => ({
          sandboxName: sandbox.name,
          reason: "provider-model" as const,
          scope: "registered" as const,
        })),
      },
    };
  }
  const custom = CUSTOM_ROUTE_PROVIDERS.has(provider);
  const candidate: GatewayInferenceRoute = {
    ...request.route,
    provider,
    model: requestedModel ?? recorded.model,
    endpointUrl: nonEmptyString(request.route.endpointUrl) ?? reference.endpointUrl,
    preferredInferenceApi:
      nonEmptyString(request.route.preferredInferenceApi) ?? reference.preferredInferenceApi,
  };
  const compatibility = checkGatewayRouteCompatibility({ ...request, route: candidate });
  if (!compatibility.ok) return { ok: false, result: compatibility };
  return {
    ok: true,
    requiredModel: recorded.model,
    requiredEndpointUrl: custom ? (nonEmptyString(reference.endpointUrl) ?? null) : null,
    requiredInferenceApi: custom ? normalizedInferenceApi(reference.preferredInferenceApi) : null,
  };
}

/**
 * Compare a requested route with every durable registry row on the same
 * OpenShell gateway. Registry rows are intentionally used without a live-state
 * filter because stopped sandboxes still depend on the gateway route when they
 * restart. The requested route must already carry the target agent's effective
 * API family; recorded peer metadata is compared literally so this guard never
 * silently treats a legacy sandbox as migrated.
 */
export function checkGatewayRouteCompatibility(
  request: GatewayRouteCompatibilityRequest,
): GatewayRouteCompatibilityResult {
  const requested = configuredRoute(request.route);
  if (!requested) {
    throw new Error("Requested gateway inference route requires a provider and model");
  }
  if (
    CUSTOM_ROUTE_PROVIDERS.has(requested.provider) &&
    (!canonicalEndpoint(request.route.endpointUrl, endpointFlavor(requested.provider)) ||
      !normalizedInferenceApi(request.route.preferredInferenceApi))
  ) {
    return {
      ok: false,
      gatewayName: request.gatewayName,
      sandboxName: request.sandboxName,
      route: requested,
      conflicts: [
        {
          sandboxName: request.sandboxName ?? "requested route",
          reason: "incomplete-custom-route",
          scope: "requested",
        },
      ],
    };
  }

  const conflicts: GatewayRouteConflict[] = [];
  for (const sandbox of request.sandboxes) {
    if (sandbox.name === request.sandboxName) continue;
    let recordedGatewayName: string;
    try {
      recordedGatewayName = resolveSandboxGatewayName(sandbox);
    } catch {
      conflicts.push({
        sandboxName: sandbox.name,
        reason: "invalid-gateway-binding",
        scope: "registered",
      });
      continue;
    }
    if (recordedGatewayName !== request.gatewayName) continue;
    const recorded = configuredRoute(sandbox);
    if (!recorded) {
      conflicts.push({
        sandboxName: sandbox.name,
        reason: "incomplete-route",
        scope: "registered",
      });
      continue;
    }

    if (recorded.provider !== requested.provider || recorded.model !== requested.model) {
      conflicts.push({
        sandboxName: sandbox.name,
        reason: "provider-model",
        scope: "registered",
      });
      continue;
    }
    if (CUSTOM_ROUTE_PROVIDERS.has(requested.provider)) {
      const reason = customRouteConflict(requested.provider, request.route, sandbox);
      if (reason) conflicts.push({ sandboxName: sandbox.name, reason, scope: "registered" });
    }
  }

  return conflicts.length === 0
    ? { ok: true }
    : {
        ok: false,
        gatewayName: request.gatewayName,
        sandboxName: request.sandboxName,
        route: requested,
        conflicts,
      };
}

function safeDisplay(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?");
}

export function formatGatewayRouteConflict(
  result: Exclude<GatewayRouteCompatibilityResult, { ok: true }>,
): string {
  const requestedRouteIncomplete = result.conflicts.some(
    (conflict) => conflict.reason === "incomplete-custom-route" && conflict.scope === "requested",
  );
  const names = [
    ...new Set(
      result.conflicts
        .filter((conflict) => conflict.scope !== "requested")
        .map((conflict) => safeDisplay(conflict.sandboxName)),
    ),
  ]
    .sort()
    .map((name) => `'${name}'`)
    .join(", ");
  const target = result.sandboxName ? ` for sandbox '${safeDisplay(result.sandboxName)}'` : "";
  const hasIncompleteCustomRoute = result.conflicts.some(
    (conflict) => conflict.reason === "incomplete-custom-route",
  );
  const hasIncompleteRoute = result.conflicts.some(
    (conflict) => conflict.reason === "incomplete-route",
  );
  const hasInvalidGatewayBinding = result.conflicts.some(
    (conflict) => conflict.reason === "invalid-gateway-binding",
  );
  const detail = [
    hasIncompleteCustomRoute
      ? "At least one custom route lacks durable endpoint or API-family metadata, so compatibility cannot be proven; remove and re-onboard that sandbox with complete custom-route metadata."
      : null,
    hasIncompleteRoute
      ? "At least one registered sandbox lacks durable provider or model metadata, so same-gateway compatibility cannot be proven; remove and re-onboard that sandbox with complete route metadata."
      : null,
    hasInvalidGatewayBinding
      ? "At least one registry row has an invalid gateway binding, so gateway separation cannot be proven; restore its known-good gateway binding or remove and re-onboard that sandbox."
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    `OpenShell gateway '${safeDisplay(result.gatewayName)}' has one inference route shared by every registered sandbox. ` +
    `Cannot set ${safeDisplay(result.route.provider)} / ${safeDisplay(result.route.model)}${target}${
      requestedRouteIncomplete
        ? " because the requested custom route lacks durable endpoint or API-family metadata."
        : ` because it conflicts with ${names}.`
    }${detail && !requestedRouteIncomplete ? ` ${detail}` : ""}\n` +
    "Stopped sandboxes are included because they use the same gateway route when restarted. " +
    (requestedRouteIncomplete
      ? "Remove and re-onboard the sandbox with complete custom-route metadata."
      : "Align the routes, remove the conflicting sandbox, or use another NEMOCLAW_GATEWAY_PORT.")
  );
}

export class GatewayRouteConflictError extends Error {
  readonly result: Exclude<GatewayRouteCompatibilityResult, { ok: true }>;

  constructor(result: Exclude<GatewayRouteCompatibilityResult, { ok: true }>) {
    super(formatGatewayRouteConflict(result));
    this.name = "GatewayRouteConflictError";
    this.result = result;
  }
}

export function assertGatewayRouteCompatibility(request: GatewayRouteCompatibilityRequest): void {
  const result = checkGatewayRouteCompatibility(request);
  if (!result.ok) throw new GatewayRouteConflictError(result);
}
