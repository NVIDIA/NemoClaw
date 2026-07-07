// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseGatewayInference } from "../inference/config";

type RunCaptureOpenshell = (args: string[], options?: { ignoreError?: boolean }) => string | null;

export function createInferenceRouteHelpers(runCaptureOpenshell: RunCaptureOpenshell) {
  function verifyInferenceRoute(_provider: string, _model: string): void {
    const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
    if (!output || /Gateway inference:\s*[\r\n]+\s*Not configured/i.test(output)) {
      console.error("  OpenShell inference route was not configured.");
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
