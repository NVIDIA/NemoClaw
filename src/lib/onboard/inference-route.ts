// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseGatewayInference } from "../inference/config";

type RunCaptureOpenshell = (args: string[], options?: { ignoreError?: boolean }) => string | null;

export function createInferenceRouteHelpers(runCaptureOpenshell: RunCaptureOpenshell) {
  function verifyInferenceRoute(provider: string, model: string): void {
    const live = parseGatewayInference(
      runCaptureOpenshell(["inference", "get"], { ignoreError: true }),
    );
    if (!live) {
      console.error("  OpenShell inference route was not configured.");
      process.exit(1);
    }
    if (live.provider !== provider || live.model !== model) {
      console.error(
        `  OpenShell inference route does not match provider '${provider}' and model '${model}'.`,
      );
      process.exit(1);
    }
  }

  function isInferenceRouteReady(provider: string, model: string): boolean {
    const live = parseGatewayInference(
      runCaptureOpenshell(["inference", "get"], { ignoreError: true }),
    );
    return Boolean(live && live.provider === provider && live.model === model);
  }

  return { verifyInferenceRoute, isInferenceRouteReady };
}
