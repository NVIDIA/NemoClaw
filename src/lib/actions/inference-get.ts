// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { sanitizeRouteValueForDisplay } from "../inference/config";
import { getLiveGatewayInference } from "../inference/live";
import { getSandboxTargetGatewayName } from "./sandbox/gateway-target";

export interface InferenceGetOptions {
  json?: boolean;
  quiet?: boolean;
  sandboxName?: string;
}

export interface InferenceGetResult {
  provider: string | null;
  model: string | null;
}

export interface InferenceGetDeps {
  captureOpenshell: typeof captureOpenshell;
  getSandboxTargetGatewayName: typeof getSandboxTargetGatewayName;
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
      formatLookupFailure(gatewayName, result.failure, result.status),
      result.status || 1,
    );
  }
  if (!result.inference) {
    throw new InferenceGetError(
      `OpenShell inference route is not configured for gateway '${gatewayName}'.`,
    );
  }

  const payload = {
    provider: result.inference.provider,
    model: result.inference.model,
  };
  if (!options.quiet) {
    if (options.json) {
      deps.log(JSON.stringify(payload, null, 2));
    } else {
      deps.log(`Provider: ${formatRouteValueForDisplay(payload.provider)}`);
      deps.log(`Model:    ${formatRouteValueForDisplay(payload.model)}`);
    }
  }

  return payload;
}

function formatLookupFailure(
  gatewayName: string,
  failure: NonNullable<ReturnType<typeof getLiveGatewayInference>["failure"]>,
  status: number | null,
): string {
  if (failure === "timeout") {
    return `OpenShell inference route lookup for gateway '${gatewayName}' timed out.`;
  }
  if (failure === "exit") {
    return `OpenShell inference route lookup for gateway '${gatewayName}' failed with exit status ${String(status ?? "unknown")}.`;
  }
  return `OpenShell inference route lookup for gateway '${gatewayName}' failed before an exit status was available.`;
}

function formatRouteValueForDisplay(value: string | null): string {
  return sanitizeRouteValueForDisplay(value) || "unknown";
}
