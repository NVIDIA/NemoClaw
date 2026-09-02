// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { unsafeEndpointUrlViolation } from "../core/endpoint-url-safety";
import { sanitizeRouteValueForDisplay } from "../inference/config";
import { getLiveGatewayInference } from "../inference/live";
import { isSharedGatewayRouteParticipant } from "../state/registry/route-reservation";
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
  endpointDiagnostic?: InferenceEndpointDiagnostic;
}

export type InferenceEndpointDiagnosticReason =
  | "missing-endpoint"
  | "invalid-endpoint"
  | "conflicting-endpoints"
  | "invalid-gateway-binding";

export interface InferenceEndpointDiagnostic {
  reason: InferenceEndpointDiagnosticReason;
  affectedSandboxNames: string[];
  additionalAffectedSandboxCount: number;
  recovery: string;
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
const MAX_DIAGNOSTIC_SANDBOX_NAMES = 5;
const MAX_DIAGNOSTIC_SANDBOX_NAME_LENGTH = 64;

type PersistedEndpointSelection =
  | { endpointUrl: string; diagnostic: null }
  | { endpointUrl: null; diagnostic: InferenceEndpointDiagnostic | null };

/** Build a bounded, terminal-safe diagnostic without rejected registry values. */
function endpointDiagnostic(
  reason: InferenceEndpointDiagnosticReason,
  sandboxNames: readonly string[],
  cliName: string,
  sandboxName: string | undefined,
): InferenceEndpointDiagnostic {
  const safeNames = [
    ...new Set(
      sandboxNames
        .map((name) =>
          sanitizeRouteValueForDisplay(name).slice(0, MAX_DIAGNOSTIC_SANDBOX_NAME_LENGTH),
        )
        .filter(Boolean),
    ),
  ].sort();
  const safeCliName = sanitizeRouteValueForDisplay(cliName).slice(0, 32) || "nemoclaw";
  const safeRequestedName = sandboxName
    ? sanitizeRouteValueForDisplay(sandboxName).slice(0, MAX_DIAGNOSTIC_SANDBOX_NAME_LENGTH)
    : null;
  const recoveryCommand = safeRequestedName
    ? `${safeCliName} ${safeRequestedName} status`
    : `${safeCliName} status`;
  return {
    reason,
    affectedSandboxNames: safeNames.slice(0, MAX_DIAGNOSTIC_SANDBOX_NAMES),
    additionalAffectedSandboxCount: Math.max(0, safeNames.length - MAX_DIAGNOSTIC_SANDBOX_NAMES),
    recovery: `Run '${recoveryCommand}' to inspect the affected registry metadata. Repair the recorded gateway binding or remove and re-onboard the affected sandbox.`,
  };
}

/** Select one safe endpoint from the route-participating rows on the live gateway. */
function getPersistedEndpointUrl(
  provider: string | null,
  gatewayName: string,
  sandboxName: string | undefined,
  cliName: string,
  deps: InferenceGetDeps,
): PersistedEndpointSelection {
  if (!provider || !COMPATIBLE_CUSTOM_PROVIDERS.has(provider)) {
    return { endpointUrl: null, diagnostic: null };
  }

  let sandboxes: ReturnType<InferenceGetDeps["listSandboxes"]>;
  try {
    sandboxes = deps.listSandboxes();
  } catch {
    const recovery = sandboxName
      ? `Run '${cliName} ${sandboxName} status' to diagnose the sandbox's registry and recorded gateway.`
      : `Run '${cliName} status' to diagnose the selected gateway and sandbox registry.`;
    throw new InferenceGetError(
      `NemoClaw could not read sandbox registry metadata for the compatible inference endpoint on gateway '${gatewayName}'. ${recovery}`,
    );
  }

  const matchingEndpoints: { endpointUrl: string; sandboxName: string }[] = [];
  const missingEndpointNames: string[] = [];
  const invalidEndpointNames: string[] = [];
  const invalidBindingNames: string[] = [];
  for (const sandbox of sandboxes) {
    if (!isSharedGatewayRouteParticipant(sandbox)) continue;
    if (sandboxName && sandbox.name !== sandboxName) continue;
    if (sandbox.provider !== provider) continue;
    try {
      if (getPersistedSandboxTargetGatewayName(sandbox) !== gatewayName) continue;
    } catch {
      invalidBindingNames.push(sandbox.name);
      continue;
    }
    if (typeof sandbox.endpointUrl !== "string" || !sandbox.endpointUrl.trim()) {
      missingEndpointNames.push(sandbox.name);
      continue;
    }
    if (unsafeEndpointUrlViolation(sandbox.endpointUrl)) {
      invalidEndpointNames.push(sandbox.name);
      continue;
    }
    matchingEndpoints.push({ endpointUrl: sandbox.endpointUrl.trim(), sandboxName: sandbox.name });
  }

  if (invalidBindingNames.length > 0) {
    return {
      endpointUrl: null,
      diagnostic: endpointDiagnostic(
        "invalid-gateway-binding",
        invalidBindingNames,
        cliName,
        sandboxName,
      ),
    };
  }
  if (invalidEndpointNames.length > 0) {
    return {
      endpointUrl: null,
      diagnostic: endpointDiagnostic(
        "invalid-endpoint",
        invalidEndpointNames,
        cliName,
        sandboxName,
      ),
    };
  }
  if (missingEndpointNames.length > 0 || matchingEndpoints.length === 0) {
    return {
      endpointUrl: null,
      diagnostic: endpointDiagnostic(
        "missing-endpoint",
        missingEndpointNames,
        cliName,
        sandboxName,
      ),
    };
  }
  const endpointUrl = matchingEndpoints[0].endpointUrl;
  if (matchingEndpoints.some((candidate) => candidate.endpointUrl !== endpointUrl)) {
    return {
      endpointUrl: null,
      diagnostic: endpointDiagnostic(
        "conflicting-endpoints",
        matchingEndpoints.map((candidate) => candidate.sandboxName),
        cliName,
        sandboxName,
      ),
    };
  }
  return { endpointUrl, diagnostic: null };
}

/** Read the live route and add safe persisted endpoint evidence when applicable. */
export async function runInferenceGet(
  options: InferenceGetOptions = {},
  deps: InferenceGetDeps = defaultDeps(),
): Promise<InferenceGetResult> {
  const gatewayName = deps.getSandboxTargetGatewayName(options.sandboxName);
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

  const endpointSelection = getPersistedEndpointUrl(
    result.inference.provider,
    gatewayName,
    options.sandboxName,
    options.cliName ?? "nemoclaw",
    deps,
  );
  const payload: InferenceGetResult = {
    provider: result.inference.provider,
    model: result.inference.model,
    ...(endpointSelection.endpointUrl ? { endpointUrl: endpointSelection.endpointUrl } : {}),
    ...(endpointSelection.diagnostic ? { endpointDiagnostic: endpointSelection.diagnostic } : {}),
  };
  if (!options.quiet) {
    if (options.json) {
      deps.log(JSON.stringify(payload, null, 2));
    } else {
      deps.log(`Provider: ${formatRouteValueForDisplay(payload.provider)}`);
      deps.log(`Model:    ${formatRouteValueForDisplay(payload.model)}`);
      if (payload.endpointUrl) {
        deps.log(`Endpoint: ${formatRouteValueForDisplay(payload.endpointUrl)}`);
      } else if (payload.endpointDiagnostic) {
        deps.log(`Endpoint: unavailable (${payload.endpointDiagnostic.reason})`);
        if (payload.endpointDiagnostic.affectedSandboxNames.length > 0) {
          const additional = payload.endpointDiagnostic.additionalAffectedSandboxCount;
          deps.log(
            `Affected sandboxes: ${payload.endpointDiagnostic.affectedSandboxNames.join(", ")}${additional > 0 ? ` (+${String(additional)} more)` : ""}`,
          );
        }
        deps.log(`Recovery: ${payload.endpointDiagnostic.recovery}`);
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
  const recovery = sandboxName
    ? `Run '${cliName} ${sandboxName} status' to diagnose the sandbox's recorded gateway.`
    : `Run '${cliName} status' to diagnose the selected gateway.`;
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
