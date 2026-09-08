// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import {
  getLlamaCppRouteDetails,
  sanitizeRouteValueForDisplay,
  type LlamaCppRouteDetails,
} from "../inference/config";
import { getLiveGatewayInference } from "../inference/live";
import { inspectManagedLlamaCppOwnership } from "../inference/llama-cpp/managed-state";
import { getKnownSandboxTarget, getSandboxTargetGatewayName } from "./sandbox/gateway-target";

export interface InferenceGetOptions {
  cliName?: string;
  json?: boolean;
  quiet?: boolean;
  sandboxName?: string;
}

export interface InferenceGetResult {
  provider: string | null;
  model: string | null;
  llamaCpp?: LlamaCppRouteDetails;
}

export interface InferenceGetDeps {
  captureOpenshell: typeof captureOpenshell;
  getSandbox?: typeof getKnownSandboxTarget;
  getSandboxTargetGatewayName: typeof getSandboxTargetGatewayName;
  log: (message?: string) => void;
  inspectManagedLlamaCppOwnership?: typeof inspectManagedLlamaCppOwnership;
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
    log: console.log,
  };
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

  const sandbox = options.sandboxName
    ? (deps.getSandbox ?? getKnownSandboxTarget)(options.sandboxName)
    : null;
  const llamaCpp =
    sandbox?.provider === result.inference.provider && sandbox.model === result.inference.model
      ? getLlamaCppRouteDetails(
          sandbox,
          deps.inspectManagedLlamaCppOwnership ?? inspectManagedLlamaCppOwnership,
        )
      : null;
  const payload: InferenceGetResult = {
    provider: result.inference.provider,
    model: result.inference.model,
    ...(llamaCpp ? { llamaCpp } : {}),
  };
  if (!options.quiet) {
    if (options.json) {
      deps.log(JSON.stringify(payload, null, 2));
    } else {
      deps.log(`Provider: ${formatRouteValueForDisplay(payload.provider)}`);
      deps.log(`Model:    ${formatRouteValueForDisplay(payload.model)}`);
      if (payload.llamaCpp) {
        deps.log(`Llama.cpp: ${payload.llamaCpp.kind}`);
        if (payload.llamaCpp.kind === "attached") {
          deps.log(`Endpoint:  ${payload.llamaCpp.endpointUrl}`);
        } else if (payload.llamaCpp.kind === "unavailable") {
          deps.log(`Ownership: ${payload.llamaCpp.diagnostic}`);
          deps.log(`Recovery:  ${payload.llamaCpp.recovery}`);
        }
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
