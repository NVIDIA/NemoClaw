// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_CLOUD_MODEL } from "../inference/config";
import type { ModelPromptOptions, ModelPromptResult } from "../inference/model-prompts";
import { promptCloudModel } from "../inference/model-prompts";
import {
  createNvidiaFeaturedModelPromptOptionsLoader,
  type NvidiaFeaturedModelOptions,
} from "../inference/nvidia-featured-models";
import { BACK_TO_SELECTION } from "../navigation";

export type NvidiaFeaturedModelSession = {
  select: (
    requestedModel: string | null,
    recoveredModel: string | null,
    nonInteractive: boolean,
    envModel?: string,
    promptOptions?: ModelPromptOptions,
  ) => Promise<ModelPromptResult>;
};

export type NvidiaFeaturedModelSessionOptions = {
  writeLine?: (message: string) => void;
  defaultModel?: string;
  loadingMessage?: string;
} & Pick<NvidiaFeaturedModelOptions, "catalogLabel" | "catalogUrl" | "retiredModelIds" | "warn">;

/** Create one catalog-backed model selector for an onboarding session. */
export function createNvidiaFeaturedModelSession(
  options: NvidiaFeaturedModelSessionOptions = {},
): NvidiaFeaturedModelSession {
  const writeLine = options.writeLine ?? console.log;
  const defaultModel = options.defaultModel?.trim() || DEFAULT_CLOUD_MODEL;
  const loadingMessage = options.loadingMessage ?? "  Loading NVIDIA's featured model catalog...";
  const loadPromptOptions = createNvidiaFeaturedModelPromptOptionsLoader({
    catalogLabel: options.catalogLabel,
    catalogUrl: options.catalogUrl,
    retiredModelIds: options.retiredModelIds,
    warn: options.warn,
  });
  let announcedLoad = false;
  return {
    async select(requestedModel, recoveredModel, nonInteractive, envModel, promptOptions) {
      if (requestedModel) return requestedModel;
      if (recoveredModel) return recoveredModel;
      const configuredModel = envModel?.trim();
      if (nonInteractive) return configuredModel || defaultModel;
      if (!announcedLoad) {
        writeLine(loadingMessage);
        announcedLoad = true;
      }
      return promptCloudModel({
        ...loadPromptOptions(configuredModel || defaultModel),
        ...promptOptions,
        manualDefaultModelId: promptOptions?.manualDefaultModelId ?? configuredModel,
      });
    },
  };
}

/**
 * Select a featured model only when the credential prompt did not ask to leave. `back` at the
 * API key prompt must return to provider selection instead of loading the catalog (#9404).
 */
export async function selectFeaturedModelAfterCredentialPrompt(
  session: NvidiaFeaturedModelSession,
  credentialNavigation: unknown,
  shouldReturnToProviderSelection: (result: unknown) => boolean,
  requestedModel: string | null,
  recoveredModel: string | null,
  nonInteractive: boolean,
  envModel?: string,
): Promise<ModelPromptResult> {
  if (shouldReturnToProviderSelection(credentialNavigation)) return BACK_TO_SELECTION;
  return session.select(requestedModel, recoveredModel, nonInteractive, envModel);
}
