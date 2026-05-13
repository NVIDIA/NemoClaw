// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell } from "../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { getLiveGatewayInference } from "../inference/live";

export interface InferenceGetOptions {
  json?: boolean;
}

export interface InferenceGetResult {
  provider: string | null;
  model: string | null;
}

export interface InferenceGetDeps {
  captureOpenshell: typeof captureOpenshell;
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

  const payload = {
    provider: result.inference.provider,
    model: result.inference.model,
  };
  if (options.json) {
    deps.log(JSON.stringify(payload, null, 2));
  } else {
    deps.log(`Provider: ${payload.provider ?? "unknown"}`);
    deps.log(`Model:    ${payload.model ?? "unknown"}`);
  }

  return payload;
}
