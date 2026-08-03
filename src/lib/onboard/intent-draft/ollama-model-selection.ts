// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requireValue } from "../../core/require-value";
import type { GpuDetection } from "../../inference/nim";
import { ollamaModelRefsMatch } from "../../inference/ollama/model-discovery";
import * as ollamaModelSize from "../../inference/ollama/model-size";
import { prepareOllamaModel, promptOllamaModel } from "../../inference/ollama/proxy";
import type { ApplyOllamaRuntimeContextWindowResult } from "../../inference/ollama-runtime-context";
import { BACK_TO_SELECTION, isBackToSelection } from "../../navigation";
import { cliName } from "../branding";
import type { InferenceSelectionValidationHelpers } from "../inference-selection-validation";
import * as ollamaFlow from "../ollama-probe-failure";
import { OllamaProbeFailureTracker } from "../ollama-probe-failure-tracker";
import type { OllamaModelSelectionDefaults } from "../setup-nim-selection";
import { assertDraftRevisionAllowed } from "./controller";
import { hasAcceptedOnboardIntent } from "./runtime";

export interface OllamaModelSelectorDeps {
  readonly isNonInteractive: () => boolean;
  readonly isAutoYes: () => boolean;
  readonly confirm: (question: string, defaultIsYes: boolean) => Promise<boolean>;
  readonly note: (message: string) => void;
  readonly abortNonInteractive: (message: string) => never;
  readonly validateOpenAiLikeSelection: InferenceSelectionValidationHelpers["validateOpenAiLikeSelection"];
  readonly isSafeModelId: (model: string) => boolean;
  readonly getOllamaModelOptions: () => string[];
  readonly resolveNonInteractiveOllamaModel: (
    requestedModel: string | null,
    recoveredModel: string | null,
    gpu: GpuDetection | null,
  ) => string;
  readonly getLocalProviderValidationBaseUrl: (provider: string) => string | null;
  readonly buildOllamaProbeOptions: (
    allowToolsIncompatible: boolean,
  ) => Parameters<InferenceSelectionValidationHelpers["validateOpenAiLikeSelection"]>[6];
  readonly applyOllamaRuntimeContextWindow: (
    selectedModel: string,
    defaults: OllamaModelSelectionDefaults,
  ) => ApplyOllamaRuntimeContextWindowResult;
  readonly prepareModel?: typeof prepareOllamaModel;
  readonly modelSizeLabel?: (model: string) => string;
}

export type OllamaModelSelector = (
  gpu: GpuDetection | null,
  provider: string,
  defaults: OllamaModelSelectionDefaults,
  onModelSelected?: (model: string) => void,
) => Promise<ollamaFlow.OllamaModelSelectionOutcome>;

/** Keep post-Apply Ollama validation forward-only while preserving the legacy selector behavior. */
export function createOllamaModelSelector(deps: OllamaModelSelectorDeps): OllamaModelSelector {
  const prepareModel = deps.prepareModel ?? prepareOllamaModel;
  const modelSizeLabel =
    deps.modelSizeLabel ??
    ((model: string) => ollamaModelSize.formatModelSize(ollamaModelSize.getOllamaModelSize(model)));
  const refuseAcceptedModelRevision = () => {
    if (hasAcceptedOnboardIntent()) {
      assertDraftRevisionAllowed("materializing", "the Ollama model", cliName());
    }
  };

  return async (gpu, provider, defaults, onModelSelected) => {
    const { requestedModel, recoveredModel, lockedModel, promptDefaultModel } = defaults;
    const probeFailures = new OllamaProbeFailureTracker();
    const interaction = {
      isNonInteractive: deps.isNonInteractive,
      isAutoYes: deps.isAutoYes,
      confirm: deps.confirm,
    };
    while (true) {
      const installedModels = deps.getOllamaModelOptions();
      let model: string | typeof BACK_TO_SELECTION;
      if (lockedModel) {
        model = lockedModel;
      } else if (deps.isNonInteractive() || hasAcceptedOnboardIntent()) {
        model = deps.resolveNonInteractiveOllamaModel(requestedModel, recoveredModel, gpu);
      } else {
        model = await promptOllamaModel(gpu, {
          defaultModel:
            promptDefaultModel && deps.isSafeModelId(promptDefaultModel)
              ? promptDefaultModel
              : null,
          excludeModels: probeFailures.excludedModels(),
        });
      }
      if (isBackToSelection(model)) {
        refuseAcceptedModelRevision();
        console.log("  Returning to provider selection.");
        console.log("");
        return { outcome: "back-to-selection" };
      }
      const selectedModel = requireValue(model, "Expected an Ollama model selection");
      onModelSelected?.(selectedModel);
      if (
        !installedModels.some((listedModel) => ollamaModelRefsMatch(listedModel, selectedModel))
      ) {
        const sizeLabel = modelSizeLabel(selectedModel);
        if (deps.isAutoYes()) {
          deps.note(`  Pulling Ollama model '${selectedModel}' (${sizeLabel}).`);
        } else if (deps.isNonInteractive()) {
          console.error(
            `  Ollama model '${selectedModel}' (${sizeLabel}) is not installed and ` +
              "non-interactive mode cannot prompt for confirmation. " +
              "Re-run with --yes / -y (or NEMOCLAW_YES=1) to authorise the download.",
          );
          process.exit(1);
        } else {
          const proceed = await deps.confirm(
            `  Download Ollama model '${selectedModel}' (${sizeLabel})?`,
            false,
          );
          if (!proceed) {
            refuseAcceptedModelRevision();
            console.error(
              `  Skipped pulling Ollama model '${selectedModel}'. Choose another model or re-run with --yes to confirm.`,
            );
            console.log("  Choose a different Ollama model or select Other.");
            console.log("");
            if (lockedModel) return { outcome: "back-to-selection" };
            continue;
          }
        }
      }
      const probe = await prepareModel(selectedModel, installedModels, interaction);
      if (!probe.ok) {
        const probeFailureLimitReached = probeFailures.recordFailure(selectedModel);
        const action = ollamaFlow.handleOllamaProbeFailure(
          probe,
          selectedModel,
          deps.isNonInteractive,
        );
        if (action === "back-to-selection") {
          refuseAcceptedModelRevision();
          return { outcome: "back-to-selection" };
        }
        if (probeFailureLimitReached) {
          refuseAcceptedModelRevision();
          console.error(probeFailures.formatLimitMessage(selectedModel));
          return { outcome: "back-to-selection" };
        }
        refuseAcceptedModelRevision();
        continue;
      }
      const allowToolsIncompatible = probe.allowToolsIncompatible === true;
      const validationBaseUrl = deps.getLocalProviderValidationBaseUrl(provider);
      if (!validationBaseUrl) {
        deps.abortNonInteractive("Local Ollama validation URL could not be determined.");
      }
      const validation = await deps.validateOpenAiLikeSelection(
        "Local Ollama",
        validationBaseUrl,
        selectedModel,
        null,
        "Choose a different Ollama model or select Other.",
        null,
        deps.buildOllamaProbeOptions(allowToolsIncompatible),
      );
      if (validation.retry === "selection") {
        refuseAcceptedModelRevision();
        return { outcome: "back-to-selection" };
      }
      if (!validation.ok) {
        if (deps.isNonInteractive()) {
          deps.abortNonInteractive(`model '${selectedModel}' failed validation.`);
        }
        refuseAcceptedModelRevision();
        if (lockedModel) return { outcome: "back-to-selection" };
        continue;
      }
      if (validation.api !== "openai-completions") {
        console.log(
          "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
        );
      }
      const selected = {
        outcome: "selected" as const,
        model: selectedModel,
        allowToolsIncompatible,
      };
      return ollamaFlow.completeOllamaRuntimeContextSelection(
        deps.applyOllamaRuntimeContextWindow(selectedModel, defaults),
        selected,
        deps.isNonInteractive,
      );
    }
  };
}
