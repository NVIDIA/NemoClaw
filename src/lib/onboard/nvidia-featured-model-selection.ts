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

export type NvidiaFeaturedModelSessionOptions = {
  writeLine?: (message: string) => void;
  defaultModel?: string;
};

/** Create one catalog-backed model selector for an onboarding session. */
export function createNvidiaFeaturedModelSession(
  options: NvidiaFeaturedModelSessionOptions = {},
): NvidiaFeaturedModelSession {
  const writeLine = options.writeLine ?? console.log;
  const defaultModel = options.defaultModel?.trim() || DEFAULT_CLOUD_MODEL;
  const loadPromptOptions = createNvidiaFeaturedModelPromptOptionsLoader();
  let announcedLoad = false;
  return {
    async select(requestedModel, recoveredModel, nonInteractive, envModel) {
      if (requestedModel) return requestedModel;
      if (recoveredModel) return recoveredModel;
      const configuredModel = envModel?.trim();
      if (nonInteractive) return configuredModel || defaultModel;
      if (!announcedLoad) {
        writeLine("  Loading NVIDIA's featured model catalog...");
        announcedLoad = true;
      }
      return promptCloudModel({
        ...loadPromptOptions(configuredModel || defaultModel),
        manualDefaultModelId: configuredModel,
      });
    },
  };
}
