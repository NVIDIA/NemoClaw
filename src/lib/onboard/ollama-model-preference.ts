// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GpuInfo } from "../inference/local";
import { promptOllamaModel } from "../inference/ollama/proxy";
import type { OllamaProbeFailureTracker } from "./ollama-probe-failure-tracker";

export function resolvePreferredOllamaModel(
  requestedModel: string | null,
  recoveredModel: string | null,
): string | null {
  return requestedModel || (process.env.NEMOCLAW_MODEL || "").trim() || recoveredModel || null;
}

export function promptOllamaModelWithPreference(
  gpu: GpuInfo | null,
  defaults: { requestedModel: string | null; recoveredModel: string | null },
  probeFailures: OllamaProbeFailureTracker,
): ReturnType<typeof promptOllamaModel> {
  const preferredModel = resolvePreferredOllamaModel(
    defaults.requestedModel,
    defaults.recoveredModel,
  );
  return promptOllamaModel(gpu, { excludeModels: probeFailures.excludedModels(), preferredModel });
}
