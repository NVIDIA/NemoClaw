// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { unsafeEndpointUrlViolation } from "../core/endpoint-url-safety";
import { sanitizeRouteValueForDisplay } from "../inference/config";
import { canonicalGatewayRouteEndpoint } from "../inference/gateway-route-compatibility";
import { parseHttpsPinRouteId } from "../inference/https-pin-runtime";
import { getLiveGatewayInference } from "../inference/live";
import { ConfigCorruptError, ConfigPermissionError } from "../state/config-io";
import { isPublishedSandboxRegistration } from "../state/registry/route-reservation";
import {
  getPersistedSandboxTargetGatewayName,
  getSandboxTargetGatewayName,
  listPersistedSandboxTargets,
} from "./sandbox/gateway-target";

export interface InferenceGetOptions {
  cliName?: string;
  json?: boolean;
  quiet?: boolean;
  sandboxName?: string;
}

export interface InferenceGetResult {
  provider: string | null;
  model: string | null;
  endpointUrl?: string;
}

export interface InferenceGetDeps {
  captureOpenshell: typeof captureOpenshell;
  getSandboxTargetGatewayName: typeof getSandboxTargetGatewayName;
  listSandboxes: typeof listPersistedSandboxTargets;
  log: (message?: string) => void;
}

export class InferenceGetError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "InferenceGetError";
  }
}

function defaultDeps(): InferenceGetDeps {
  return {
    captureOpenshell,
    getSandboxTargetGatewayName,
    listSandboxes: listPersistedSandboxTargets,
    log: console.log,
  };
}

const COMPATIBLE_CUSTOM_PROVIDERS = new Set([
  "compatible-endpoint",
  "compatible-anthropic-endpoint",
]);

function formatStatusRecovery(cliName: string, sandboxName: string | undefined): string {
  return sandboxName
    ? `Run '${cliName} ${sandboxName} status' to diagnose the sandbox's recorded gateway.`
    : `Run '${cliName} status' to diagnose the selected gateway.`;
}

function formatRegistryReadFailure(
  error: unknown,
  cliName: string,
  sandboxName: string | undefined,
): string {
  const summary =
    "NemoClaw could not read sandbox registry metadata for the compatible inference endpoint.";
  if (error instanceof ConfigCorruptError || error instanceof ConfigPermissionError) {
    return `${summary}\n\n${error.message}`;
  }
  return `${summary} ${formatStatusRecovery(cliName, sandboxName)}`;
}

/** Select one safe endpoint from published rows on the live gateway. */
function getPersistedEndpointUrl(
  provider: string | null,
  model: string | null,
  gatewayName: string,
  sandboxName: string | undefined,
  cliName: string,
  deps: InferenceGetDeps,
): string | null {
  const liveModel = model?.trim();
  if (!provider || !liveModel || !COMPATIBLE_CUSTOM_PROVIDERS.has(provider)) {
    return null;
  }

  let sandboxes: ReturnType<InferenceGetDeps["listSandboxes"]>;
  try {
    sandboxes = deps.listSandboxes();
  } catch (error) {
    throw new InferenceGetError(formatRegistryReadFailure(error, cliName, sandboxName));
  }

  const matchingEndpoints: { canonical: string; display: string }[] = [];
  let incompleteMatchingMetadata = false;
  for (const sandbox of sandboxes) {
    if (!isPublishedSandboxRegistration(sandbox)) continue;
    if (sandboxName && sandbox.name !== sandboxName) continue;
    if (sandbox.provider !== provider) continue;
    try {
      if (getPersistedSandboxTargetGatewayName(sandbox) !== gatewayName) continue;
    } catch {
      // A matching row with an invalid binding could belong to this gateway.
      // Omit the endpoint unless every participating row can be scoped safely.
      incompleteMatchingMetadata = true;
      continue;
    }
    if (typeof sandbox.model !== "string" || sandbox.model.trim() !== liveModel) {
      incompleteMatchingMetadata = true;
      continue;
    }
    if (typeof sandbox.endpointUrl !== "string" || !sandbox.endpointUrl.trim()) {
      incompleteMatchingMetadata = true;
      continue;
    }
    if (unsafeEndpointUrlViolation(sandbox.endpointUrl)) {
      incompleteMatchingMetadata = true;
      continue;
    }
    if (parseHttpsPinRouteId(sandbox.endpointUrl)) {
      // HTTPS-pin registry state intentionally retains only the opaque adapter
      // route. It cannot be reused as the upstream endpoint with inference set.
      incompleteMatchingMetadata = true;
      continue;
    }
    const display = sandbox.endpointUrl.trim();
    const canonical = canonicalGatewayRouteEndpoint(provider, display);
    if (!canonical) {
      incompleteMatchingMetadata = true;
      continue;
    }
    matchingEndpoints.push({ canonical, display });
  }
  if (incompleteMatchingMetadata || matchingEndpoints.length === 0) {
    return null;
  }
  const selected = matchingEndpoints[0];
  return matchingEndpoints.some((candidate) => candidate.canonical !== selected.canonical)
    ? null
    : selected.display;
}

/** Read the live route and add safe persisted endpoint evidence when applicable. */
export async function runInferenceGet(
  options: InferenceGetOptions = {},
  deps: InferenceGetDeps = defaultDeps(),
): Promise<InferenceGetResult> {
  let gatewayName: string;
  try {
    gatewayName = deps.getSandboxTargetGatewayName(options.sandboxName);
  } catch {
    throw new InferenceGetError("NemoClaw could not resolve the sandbox's recorded gateway.");
  }
  const result = getLiveGatewayInference(deps.captureOpenshell, {
    gatewayName,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (result.failure) {
    throw new InferenceGetError(
      formatLookupFailure(
        gatewayName,
        result.failure,
        result.status,
        options.cliName ?? "nemoclaw",
        options.sandboxName,
      ),
      result.status || 1,
    );
  }
  if (!result.inference) {
    throw new InferenceGetError(
      `OpenShell inference route is not configured for gateway '${gatewayName}'.`,
    );
  }

  const endpointUrl = getPersistedEndpointUrl(
    result.inference.provider,
    result.inference.model,
    gatewayName,
    options.sandboxName,
    options.cliName ?? "nemoclaw",
    deps,
  );
  const payload: InferenceGetResult = {
    provider: result.inference.provider,
    model: result.inference.model,
    ...(endpointUrl ? { endpointUrl } : {}),
  };
  if (!options.quiet) {
    if (options.json) {
      deps.log(JSON.stringify(payload, null, 2));
    } else {
      deps.log(`Provider: ${formatRouteValueForDisplay(payload.provider)}`);
      deps.log(`Model:    ${formatRouteValueForDisplay(payload.model)}`);
      if (payload.endpointUrl) {
        deps.log(`Endpoint: ${formatRouteValueForDisplay(payload.endpointUrl)}`);
      }
    }
  }

  return payload;
}

function formatLookupFailure(
  gatewayName: string,
  failure: NonNullable<ReturnType<typeof getLiveGatewayInference>["failure"]>,
  status: number | null,
  cliName: string,
  sandboxName: string | undefined,
): string {
  const recovery = formatStatusRecovery(cliName, sandboxName);
  if (failure === "timeout") {
    return `OpenShell inference route lookup for gateway '${gatewayName}' timed out. ${recovery}`;
  }
  if (failure === "exit") {
    return `OpenShell inference route lookup for gateway '${gatewayName}' failed with exit status ${String(status ?? "unknown")}. ${recovery}`;
  }
  if (failure === "output") {
    return `OpenShell inference route lookup for gateway '${gatewayName}' returned output NemoClaw could not interpret. ${recovery}`;
  }
  return `OpenShell inference route lookup for gateway '${gatewayName}' failed before an exit status was available. ${recovery}`;
}

function formatRouteValueForDisplay(value: string | null): string {
  return sanitizeRouteValueForDisplay(value) || "unknown";
}
