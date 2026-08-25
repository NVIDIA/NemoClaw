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
import * as registry from "../state/registry";

export interface InferenceGetOptions {
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
  getSandbox?: typeof registry.getSandbox;
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
    log: console.log,
  };
}

export async function runInferenceGet(
  options: InferenceGetOptions = {},
  deps: InferenceGetDeps = defaultDeps(),
): Promise<InferenceGetResult> {
  const result = getLiveGatewayInference(deps.captureOpenshell, {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new InferenceGetError("OpenShell inference route lookup failed.", result.status || 1);
  }
  if (!result.inference) {
    throw new InferenceGetError("OpenShell inference route is not configured.");
  }

  const sandbox = options.sandboxName
    ? (deps.getSandbox ?? registry.getSandbox)(options.sandboxName)
    : null;
  const llamaCpp =
    sandbox?.provider === result.inference.provider && sandbox.model === result.inference.model
      ? getLlamaCppRouteDetails(sandbox)
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
        }
      }
    }
  }

  return payload;
}

function formatRouteValueForDisplay(value: string | null): string {
  return sanitizeRouteValueForDisplay(value) || "unknown";
}
