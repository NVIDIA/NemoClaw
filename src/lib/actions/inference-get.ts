// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { unsafeEndpointUrlViolation } from "../core/endpoint-url-safety";
import { sanitizeRouteValueForDisplay } from "../inference/config";
import { canonicalGatewayRouteEndpoint } from "../inference/gateway-route-compatibility";
import { parseHttpsPinRouteId } from "../inference/https-pin-runtime";
import { getLiveGatewayInference } from "../inference/live";
import { valueLooksLikeSecret } from "../security/credential-filter";
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
  endpointStatus?: InferenceEndpointStatus;
  endpointRecovery?: string;
  affectedSandboxes?: string[];
  affectedSandboxesTruncated?: boolean;
}

export type InferenceEndpointStatus =
  | "unavailable"
  | "invalid"
  | "conflicting"
  | "withheld"
  | "adapter-managed";

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

// Only display endpoint paths whose complete shape is a documented API base.
// Other persisted paths can be valid for routing but may contain opaque
// credentials, so the read path omits them instead of guessing their meaning.
const DISPLAYABLE_ENDPOINT_PATHS = new Set(["/", "/v1", "/v1/"]);

const ENDPOINT_RECOVERY: Record<InferenceEndpointStatus, string> = {
  unavailable:
    "Restore registry access or record the trusted endpoint and API family again, then rerun inference get.",
  invalid:
    "Repair the named sandbox registrations' compatible-route metadata, then rerun inference get; repeat if additional affected registrations are reported.",
  conflicting:
    "Align or remove the named conflicting same-gateway sandbox routes, then rerun inference get; repeat if additional affected registrations are reported.",
  withheld: "Use a credential-free root or /v1 API base if endpoint readback is required.",
  "adapter-managed":
    "For a same-provider model change, omit endpoint options so NemoClaw reuses the recorded route.",
};

type PersistedEndpointResult =
  | { endpointUrl: string }
  | {
      endpointStatus: InferenceEndpointStatus;
      endpointRecovery: string;
      affectedSandboxes?: string[];
      affectedSandboxesTruncated?: boolean;
    }
  | Record<string, never>;

const MAX_AFFECTED_SANDBOXES = 8;
// This is a diagnostic-output allowlist, not a sandbox-name validator. It may
// omit a valid future name; it must never broaden name acceptance or authority.
const SAFE_DIAGNOSTIC_SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function formatStatusRecovery(cliName: string, sandboxName: string | undefined): string {
  return sandboxName
    ? `Run '${cliName} ${sandboxName} status' to diagnose the sandbox's recorded gateway.`
    : `Run '${cliName} status' to diagnose the selected gateway.`;
}

function formatGatewayResolutionFailure(error: unknown): string {
  const summary = "NemoClaw could not resolve the sandbox's recorded gateway.";
  if (error instanceof ConfigCorruptError || error instanceof ConfigPermissionError) {
    return `${summary}\n\n${error.message}`;
  }
  return summary;
}

function endpointPathIsCredentialFreeForDisplay(endpointUrl: string): boolean {
  try {
    return DISPLAYABLE_ENDPOINT_PATHS.has(new URL(endpointUrl.trim()).pathname);
  } catch {
    return false;
  }
}

/** Select one safe endpoint from published rows on the live gateway. */
function safeAffectedSandboxNames(names: Iterable<string>): {
  affectedSandboxes: string[];
  affectedSandboxesTruncated: boolean;
} {
  const safeNames = [...new Set(names)]
    .filter((name) => SAFE_DIAGNOSTIC_SANDBOX_NAME.test(name))
    .sort();
  return {
    affectedSandboxes: safeNames.slice(0, MAX_AFFECTED_SANDBOXES),
    affectedSandboxesTruncated: safeNames.length > MAX_AFFECTED_SANDBOXES,
  };
}

function endpointOmission(
  endpointStatus: InferenceEndpointStatus,
  affectedNames: Iterable<string> = [],
): PersistedEndpointResult {
  const { affectedSandboxes, affectedSandboxesTruncated } = safeAffectedSandboxNames(affectedNames);
  return {
    endpointStatus,
    endpointRecovery: ENDPOINT_RECOVERY[endpointStatus],
    ...(affectedSandboxes.length > 0 ? { affectedSandboxes } : {}),
    ...(affectedSandboxesTruncated ? { affectedSandboxesTruncated } : {}),
  };
}

function getPersistedEndpoint(
  provider: string | null,
  model: string | null,
  gatewayName: string,
  sandboxName: string | undefined,
  deps: InferenceGetDeps,
): PersistedEndpointResult {
  const liveModel = model?.trim();
  if (!provider || !COMPATIBLE_CUSTOM_PROVIDERS.has(provider)) {
    return {};
  }
  if (!liveModel) {
    return endpointOmission("invalid");
  }

  let sandboxes: ReturnType<InferenceGetDeps["listSandboxes"]>;
  try {
    sandboxes = deps.listSandboxes();
  } catch {
    return endpointOmission("unavailable");
  }

  const matchingEndpoints: { canonical: string; display: string; sandboxName: string }[] = [];
  const invalidSandboxNames = new Set<string>();
  let invalidMetadata = false;
  let withheldMetadata = false;
  let adapterMetadata = false;
  let targetRowParticipates = sandboxName === undefined;
  for (const sandbox of sandboxes) {
    if (!isPublishedSandboxRegistration(sandbox)) continue;
    if (sandbox.provider !== provider) continue;
    try {
      if (getPersistedSandboxTargetGatewayName(sandbox) !== gatewayName) continue;
    } catch {
      // A matching row with an invalid binding could belong to this gateway.
      // Omit the endpoint unless every participating row can be scoped safely.
      invalidMetadata = true;
      invalidSandboxNames.add(sandbox.name);
      continue;
    }
    if (sandbox.name === sandboxName) targetRowParticipates = true;
    if (typeof sandbox.model !== "string" || sandbox.model.trim() !== liveModel) {
      invalidMetadata = true;
      invalidSandboxNames.add(sandbox.name);
      continue;
    }
    if (typeof sandbox.endpointUrl !== "string" || !sandbox.endpointUrl.trim()) {
      invalidMetadata = true;
      invalidSandboxNames.add(sandbox.name);
      continue;
    }
    if (unsafeEndpointUrlViolation(sandbox.endpointUrl)) {
      invalidMetadata = true;
      invalidSandboxNames.add(sandbox.name);
      continue;
    }
    if (parseHttpsPinRouteId(sandbox.endpointUrl)) {
      // HTTPS-pin registry state intentionally retains only the opaque adapter
      // route. It cannot be reused as the upstream endpoint with inference set.
      adapterMetadata = true;
      continue;
    }
    if (valueLooksLikeSecret(sandbox.endpointUrl)) {
      withheldMetadata = true;
      continue;
    }
    if (!endpointPathIsCredentialFreeForDisplay(sandbox.endpointUrl)) {
      withheldMetadata = true;
      continue;
    }
    const display = sandbox.endpointUrl.trim();
    const canonical = canonicalGatewayRouteEndpoint(provider, display);
    if (!canonical) {
      invalidMetadata = true;
      invalidSandboxNames.add(sandbox.name);
      continue;
    }
    matchingEndpoints.push({ canonical, display, sandboxName: sandbox.name });
  }
  if (!targetRowParticipates && sandboxName) {
    invalidMetadata = true;
    invalidSandboxNames.add(sandboxName);
  }
  if (withheldMetadata) return endpointOmission("withheld");
  if (invalidMetadata) return endpointOmission("invalid", invalidSandboxNames);
  if (adapterMetadata) return endpointOmission("adapter-managed");
  if (matchingEndpoints.length === 0) return endpointOmission("unavailable");
  const selected = matchingEndpoints[0];
  return matchingEndpoints.some((candidate) => candidate.canonical !== selected.canonical)
    ? endpointOmission(
        "conflicting",
        matchingEndpoints.map((candidate) => candidate.sandboxName),
      )
    : { endpointUrl: selected.display };
}

/** Read the live route and add safe persisted endpoint evidence when applicable. */
export async function runInferenceGet(
  options: InferenceGetOptions = {},
  deps: InferenceGetDeps = defaultDeps(),
): Promise<InferenceGetResult> {
  let gatewayName: string;
  try {
    gatewayName = deps.getSandboxTargetGatewayName(options.sandboxName);
  } catch (error) {
    throw new InferenceGetError(formatGatewayResolutionFailure(error));
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

  const endpoint = getPersistedEndpoint(
    result.inference.provider,
    result.inference.model,
    gatewayName,
    options.sandboxName,
    deps,
  );
  const payload: InferenceGetResult = {
    provider: result.inference.provider,
    model: result.inference.model,
    ...endpoint,
  };
  if (!options.quiet) {
    if (options.json) {
      deps.log(JSON.stringify(payload, null, 2));
    } else {
      deps.log(`Provider: ${formatRouteValueForDisplay(payload.provider)}`);
      deps.log(`Model:    ${formatRouteValueForDisplay(payload.model)}`);
      if (payload.endpointUrl) {
        deps.log(`Endpoint: ${formatRouteValueForDisplay(payload.endpointUrl)}`);
      } else if (payload.endpointStatus && payload.endpointRecovery) {
        deps.log(`Endpoint: unavailable (${payload.endpointStatus})`);
        if (payload.affectedSandboxes?.length) {
          const truncation = payload.affectedSandboxesTruncated
            ? " (additional output-safe names not shown)"
            : "";
          deps.log(`Affected: ${payload.affectedSandboxes.join(", ")}${truncation}`);
        }
        deps.log(`Action:   ${payload.endpointRecovery}`);
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
