// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LLAMA_CPP_CREDENTIAL_ENV,
  LLAMA_CPP_HOST_OPENAI_BASE_URL,
  LLAMA_CPP_PROVIDER_LABEL,
  LLAMA_CPP_PROVIDER_NAME,
  type LlamaCppAttachmentResult,
} from "../../inference/llama-cpp";
import type { SetupNimSelectionResult, SetupNimSelectionState } from "../setup-nim-flow";

type CredentialNavigation = string | Readonly<{ kind: string }>;

export interface LlamaCppSelectionDeps {
  isNonInteractive(): boolean;
  resolveCredential(envName: string): string | null;
  ensureNamedCredential(envName: string, label: string): Promise<CredentialNavigation>;
  returningToProviderSelection(result: unknown): boolean;
  probeLlamaCppAttachment(
    apiKey: string,
    options: { requestedModel?: string | null },
  ): LlamaCppAttachmentResult;
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
  error(message: string): void;
  log(message: string): void;
  exitProcess(code: number): never;
}

/** Attach only to a positively classified, operator-run llama.cpp server. */
export function createLlamaCppSelectionHandler(
  deps: LlamaCppSelectionDeps,
): (
  state: SetupNimSelectionState,
  requestedModel: string | null,
  recoveredModel: string | null,
) => Promise<SetupNimSelectionResult> {
  return async function handleLlamaCppSelection(
    state,
    requestedModel,
    recoveredModel,
  ): Promise<SetupNimSelectionResult> {
    let apiKey = deps.resolveCredential(LLAMA_CPP_CREDENTIAL_ENV);
    if (!apiKey && deps.isNonInteractive()) {
      deps.error(`  ${LLAMA_CPP_CREDENTIAL_ENV} is required for Local llama.cpp.`);
      return deps.exitProcess(1);
    }
    if (!apiKey) {
      const credential = await deps.ensureNamedCredential(
        LLAMA_CPP_CREDENTIAL_ENV,
        "Local llama.cpp native API key",
      );
      if (deps.returningToProviderSelection(credential)) return "retry-selection";
      apiKey = typeof credential === "string" ? credential : null;
    }
    if (!apiKey) {
      deps.error("  A native llama.cpp API key is required for existing-server attachment.");
      return deps.isNonInteractive() ? deps.exitProcess(1) : "retry-selection";
    }

    state.provider = LLAMA_CPP_PROVIDER_NAME;
    state.endpointUrl = LLAMA_CPP_HOST_OPENAI_BASE_URL;
    state.credentialEnv = LLAMA_CPP_CREDENTIAL_ENV;
    state.preferredInferenceApi = "openai-completions";
    state.model = requestedModel || recoveredModel;
    state.assertRouteCompatible?.();

    const constrainedModel = typeof state.model === "string" ? state.model : null;
    const attachment = deps.probeLlamaCppAttachment(apiKey, {
      requestedModel: constrainedModel,
    });
    if (!attachment.ok) {
      deps.error(`  ${attachment.message}`);
      deps.error("  NemoClaw did not attach this server as llama.cpp.");
      deps.error("  Select Other OpenAI-compatible endpoint to configure it.");
      return deps.isNonInteractive() ? deps.exitProcess(1) : "retry-selection";
    }

    state.model = attachment.model;
    state.assertRouteCompatible?.();
    const validation = await deps.validateOpenAiLikeSelection(
      LLAMA_CPP_PROVIDER_LABEL,
      LLAMA_CPP_HOST_OPENAI_BASE_URL,
      attachment.model,
      LLAMA_CPP_CREDENTIAL_ENV,
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
    deps.log(`  Attached Local llama.cpp with served model alias: ${attachment.model}`);
    return "selected";
  };
}
