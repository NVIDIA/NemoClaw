// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { sanitizeRouteValueForDisplay } from "../inference/config";
import { safePersistedCompatibleEndpointUrl } from "../inference/gateway-route-compatibility";
import { getLiveGatewayInference } from "../inference/live";
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

function getPersistedEndpointUrl(
  provider: string | null,
  gatewayName: string,
  sandboxName: string | undefined,
  cliName: string,
  deps: InferenceGetDeps,
): string | null {
  if (!provider || !COMPATIBLE_CUSTOM_PROVIDERS.has(provider)) return null;

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

  const matchingEndpoints: Array<string | null> = [];
  for (const sandbox of sandboxes) {
    if (sandboxName && sandbox.name !== sandboxName) continue;
    if (sandbox.provider !== provider) continue;
    try {
      if (getPersistedSandboxTargetGatewayName(sandbox) !== gatewayName) continue;
    } catch {
      continue;
    }
    matchingEndpoints.push(safePersistedCompatibleEndpointUrl(sandbox.endpointUrl));
  }

  const endpointUrl = matchingEndpoints[0];
  return endpointUrl && matchingEndpoints.every((candidate) => candidate === endpointUrl)
    ? endpointUrl
    : null;
}

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

  const endpointUrl = getPersistedEndpointUrl(
    result.inference.provider,
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
