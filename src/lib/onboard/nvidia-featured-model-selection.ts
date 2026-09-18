// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_CLOUD_MODEL } from "../inference/config";
import type { ModelPromptOptions, ModelPromptResult } from "../inference/model-prompts";
import { promptCloudModel } from "../inference/model-prompts";
import {
  createNvidiaFeaturedModelPromptOptionsLoader,
  isRetiredNvidiaFeaturedModelId,
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
} & Pick<
  NvidiaFeaturedModelOptions,
  "catalogLabel" | "catalogUrl" | "fallbackModelOptions" | "retiredModelIds" | "warn"
>;

/** Create one catalog-backed model selector for an onboarding session. */
export function createNvidiaFeaturedModelSession(
  options: NvidiaFeaturedModelSessionOptions = {},
): NvidiaFeaturedModelSession {
  const writeLine = options.writeLine ?? console.log;
  const defaultModel = options.defaultModel?.trim() || DEFAULT_CLOUD_MODEL;
  const warn = options.warn ?? console.warn;
  const loadingMessage = options.loadingMessage ?? "  Loading NVIDIA's featured model catalog...";
  const loadPromptOptions = createNvidiaFeaturedModelPromptOptionsLoader({
    catalogLabel: options.catalogLabel,
    catalogUrl: options.catalogUrl,
    fallbackModelOptions: options.fallbackModelOptions,
    retiredModelIds: options.retiredModelIds,
    warn: options.warn,
  });
  let announcedLoad = false;
  return {
    async select(requestedModel, recoveredModel, nonInteractive, envModel, promptOptions) {
      const configuredModel = envModel?.trim();
      const configuredModelIsRetired = Boolean(
        configuredModel && isRetiredNvidiaFeaturedModelId(configuredModel, options.retiredModelIds),
      );
      const requestedModelIsRetired = Boolean(
        requestedModel && isRetiredNvidiaFeaturedModelId(requestedModel, options.retiredModelIds),
      );
      if (requestedModel) {
        if (!requestedModelIsRetired) {
          return requestedModel;
        }
        const replacementModel =
          configuredModel && !configuredModelIsRetired ? configuredModel : defaultModel;
        warn(
          nonInteractive
            ? `  Warning: configured NVIDIA model "${requestedModel}" is retired; ignoring it and using "${replacementModel}" instead.`
            : `  Warning: configured NVIDIA model "${requestedModel}" is retired; choose a replacement model.`,
        );
        if (nonInteractive) return replacementModel;
      }
      if (recoveredModel && !requestedModelIsRetired) {
        if (!isRetiredNvidiaFeaturedModelId(recoveredModel, options.retiredModelIds)) {
          return recoveredModel;
        }
        warn(
          nonInteractive
            ? `  Warning: recovered NVIDIA model "${recoveredModel}" is retired; using "${configuredModel && !configuredModelIsRetired ? configuredModel : defaultModel}" instead.`
            : `  Warning: recovered NVIDIA model "${recoveredModel}" is retired; choose a replacement model.`,
        );
      }
      if (nonInteractive) {
        return configuredModel && !configuredModelIsRetired ? configuredModel : defaultModel;
      }
      if (!announcedLoad) {
        writeLine(loadingMessage);
        announcedLoad = true;
      }
      return promptCloudModel({
        ...loadPromptOptions(
          configuredModel && !configuredModelIsRetired ? configuredModel : defaultModel,
        ),
        ...promptOptions,
        manualDefaultModelId:
          promptOptions?.manualDefaultModelId ??
          (configuredModel && !configuredModelIsRetired ? configuredModel : undefined),
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
  selection: { requestedModel: string | null; constrainedModel?: ModelPromptResult | null },
  recoveredModel: string | null,
  nonInteractive: boolean,
  envModel?: string,
): Promise<ModelPromptResult> {
  if (shouldReturnToProviderSelection(credentialNavigation)) return BACK_TO_SELECTION;
  const { requestedModel, constrainedModel } = selection;
  const effectiveRequestedModel =
    requestedModel ??
    (typeof constrainedModel === "string" &&
    constrainedModel.trim() &&
    constrainedModel !== recoveredModel
      ? constrainedModel
      : null);
  return session.select(effectiveRequestedModel, recoveredModel, nonInteractive, envModel);
}
