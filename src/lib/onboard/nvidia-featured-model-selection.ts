// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_CLOUD_MODEL } from "../inference/config";
import type { ModelPromptResult } from "../inference/model-prompts";
import { promptCloudModel } from "../inference/model-prompts";
import { createNvidiaFeaturedModelPromptOptionsLoader } from "../inference/nvidia-featured-models";

export type NvidiaFeaturedModelSession = {
  select: (
    requestedModel: string | null,
    recoveredModel: string | null,
    nonInteractive: boolean,
    envModel?: string,
  ) => Promise<ModelPromptResult>;
};

/** Create one catalog-backed model selector for an onboarding session. */
export function createNvidiaFeaturedModelSession(
  writeLine: (message: string) => void = console.log,
): NvidiaFeaturedModelSession {
  const loadPromptOptions = createNvidiaFeaturedModelPromptOptionsLoader();
  let announcedLoad = false;
  return {
    async select(requestedModel, recoveredModel, nonInteractive, envModel) {
      if (requestedModel) return requestedModel;
      if (recoveredModel) return recoveredModel;
      if (nonInteractive) return DEFAULT_CLOUD_MODEL;
      if (!announcedLoad) {
        writeLine("  Loading NVIDIA's featured model catalog...");
        announcedLoad = true;
      }
      const configuredModel = envModel?.trim();
      return promptCloudModel({
        ...loadPromptOptions(configuredModel),
        manualDefaultModelId: configuredModel,
      });
    },
  };
}
