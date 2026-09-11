// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LLMMAN_CREDENTIAL_ENV,
  LLMMAN_HOST_OPENAI_BASE_URL,
  LLMMAN_PROVIDER_LABEL,
  LLMMAN_PROVIDER_NAME,
  type LlmmanAttachmentResult,
  probeLlmmanAttachment as probeLlmmanAttachmentImpl,
} from "../../inference/llmman";
import { getNavigationChoice } from "../prompt-helpers";
import type { ProviderMenuChoice } from "../provider-menu";
import type { SetupNimSelectionResult, SetupNimSelectionState } from "../setup-nim-flow";

type CredentialNavigation = string | Readonly<{ kind: string }>;

export interface LlmmanSelectionDeps {
  isNonInteractive(): boolean;
  resolveCredential(envName: string): string | null;
  ensureNamedCredential(envName: string, label: string): Promise<CredentialNavigation>;
  returningToProviderSelection(result: unknown): boolean;
  probeLlmmanAttachment?(
    apiKey: string,
    options: { requestedModel?: string | null },
  ): LlmmanAttachmentResult;
  validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null,
    retryMessage?: string,
    helpUrl?: string | null,
    options?: {
      apiKey?: string | null;
      pinnedAddresses?: readonly string[];
      skipResponsesProbe?: boolean;
    },
  ): Promise<{ ok: boolean; retry?: string; api?: string | null }>;
  prompt(message: string): Promise<string>;
  selectFromNumberedMenu(
    rawChoice: string,
    defaultIndex: number,
    options: ProviderMenuChoice[],
  ): ProviderMenuChoice;
  error(message: string): void;
  log(message: string): void;
  exitProcess(code: number): never;
}

const BACK_TO_PROVIDER_KEY = "__back__";

/** Numbered menu of the stored llmman models; `back` returns to provider selection. */
async function promptForStoredModel(
  deps: LlmmanSelectionDeps,
  availableModels: readonly string[],
): Promise<string | null> {
  const options: ProviderMenuChoice[] = availableModels.map((model) => ({
    key: model,
    label: model,
  }));
  options.push({ key: BACK_TO_PROVIDER_KEY, label: "Back to provider selection" });
  deps.log("");
  deps.log("  Models stored by llmman:");
  options.forEach((option, index) => {
    deps.log(`    ${index + 1}) ${option.label}`);
  });
  const rawChoice = await deps.prompt("  Choose a model [1]: ");
  if (getNavigationChoice(rawChoice) === "back") return null;
  const selected = deps.selectFromNumberedMenu(rawChoice, 1, options);
  return selected.key === BACK_TO_PROVIDER_KEY ? null : selected.key;
}

/** Attach only to an authenticated llmman daemon on the fixed loopback port. */
export function createLlmmanSelectionHandler(
  deps: LlmmanSelectionDeps,
): (
  state: SetupNimSelectionState,
  requestedModel: string | null,
  recoveredModel: string | null,
) => Promise<SetupNimSelectionResult> {
  const probeLlmmanAttachment = deps.probeLlmmanAttachment ?? probeLlmmanAttachmentImpl;
  return async function handleLlmmanSelection(
    state,
    requestedModel,
    recoveredModel,
  ): Promise<SetupNimSelectionResult> {
    let apiKey = deps.resolveCredential(LLMMAN_CREDENTIAL_ENV);
    if (!apiKey && deps.isNonInteractive()) {
      deps.error(`  ${LLMMAN_CREDENTIAL_ENV} is required for ${LLMMAN_PROVIDER_LABEL}.`);
      return deps.exitProcess(1);
    }
    if (!apiKey) {
      const credential = await deps.ensureNamedCredential(
        LLMMAN_CREDENTIAL_ENV,
        "Local llmman API key (LLMMAN_API_KEYS)",
      );
      if (deps.returningToProviderSelection(credential)) return "retry-selection";
      apiKey = typeof credential === "string" ? credential : null;
    }
    if (!apiKey) {
      deps.error("  An llmman API key is required for existing-server attachment.");
      return deps.isNonInteractive() ? deps.exitProcess(1) : "retry-selection";
    }

    state.provider = LLMMAN_PROVIDER_NAME;
    state.endpointUrl = LLMMAN_HOST_OPENAI_BASE_URL;
    state.credentialEnv = LLMMAN_CREDENTIAL_ENV;
    state.preferredInferenceApi = "openai-completions";
    state.model = requestedModel || recoveredModel;
    state.assertRouteCompatible?.();

    const constrainedModel = typeof state.model === "string" ? state.model : null;
    let attachment = probeLlmmanAttachment(apiKey, { requestedModel: constrainedModel });
    if (
      !attachment.ok &&
      attachment.reason === "ambiguous-model" &&
      !deps.isNonInteractive() &&
      (attachment.availableModels?.length ?? 0) > 1
    ) {
      const chosen = await promptForStoredModel(deps, attachment.availableModels ?? []);
      if (!chosen) return "retry-selection";
      attachment = probeLlmmanAttachment(apiKey, { requestedModel: chosen });
    }
    if (!attachment.ok) {
      deps.error(`  ${attachment.message}`);
      if (attachment.reason === "model-not-found" && attachment.availableModels?.length) {
        deps.error(`  Stored models: ${attachment.availableModels.join(", ")}`);
      }
      deps.error(`  NemoClaw did not attach this server as ${LLMMAN_PROVIDER_LABEL}.`);
      return deps.isNonInteractive() ? deps.exitProcess(1) : "retry-selection";
    }

    state.model = attachment.model;
    state.assertRouteCompatible?.();
    const validation = await deps.validateOpenAiLikeSelection(
      LLMMAN_PROVIDER_LABEL,
      LLMMAN_HOST_OPENAI_BASE_URL,
      attachment.model,
      LLMMAN_CREDENTIAL_ENV,
      "Choose a provider and model again.",
      null,
      {
        apiKey,
        pinnedAddresses: [],
        skipResponsesProbe: true,
      },
    );
    if (!validation.ok || validation.retry === "selection" || validation.retry === "model") {
      return "retry-selection";
    }
    state.preferredInferenceApi = "openai-completions";
    deps.log(
      `  Attached ${LLMMAN_PROVIDER_LABEL} ${attachment.version} with model: ${attachment.model}`,
    );
    return "selected";
  };
}
