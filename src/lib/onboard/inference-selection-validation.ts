// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential } from "../credentials/store";

const { probeAnthropicEndpoint, probeOpenAiLikeEndpoint } =
  require("../inference/onboard-probes") as {
    probeAnthropicEndpoint(
      endpointUrl: string,
      model: string,
      apiKey: string | null | undefined,
    ): any;
    probeOpenAiLikeEndpoint(
      endpointUrl: string,
      model: string,
      apiKey: string | null | undefined,
      options?: Record<string, unknown>,
    ): any;
  };

import { shouldForceCompletionsApi } from "../validation";
import { getProbeRecovery } from "../validation-recovery";

export type EndpointValidationResult =
  | { ok: true; api: string | null; retry?: undefined }
  | { ok: false; retry: "credential" | "selection" | "retry" | "model"; api?: undefined };

export interface InferenceSelectionValidationDeps {
  isNonInteractive(): boolean;
  agentProductName(): string;
  promptValidationRecovery(
    label: string,
    recovery: ReturnType<typeof getProbeRecovery>,
    credentialEnv?: string | null,
    helpUrl?: string | null,
  ): Promise<"credential" | "selection" | "retry" | "model">;
}

export interface InferenceSelectionValidationHelpers {
  validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv?: string | null,
    retryMessage?: string,
    helpUrl?: string | null,
    options?: {
      authMode?: "bearer" | "query-param";
      requireResponsesToolCalling?: boolean;
      requireChatCompletionsToolCalling?: boolean;
      skipResponsesProbe?: boolean;
      probeStreaming?: boolean;
      allowHostDockerInternal?: boolean;
    },
  ): Promise<EndpointValidationResult>;
  validateAnthropicSelectionWithRetryMessage(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    retryMessage?: string,
    helpUrl?: string | null,
  ): Promise<EndpointValidationResult>;
  validateCustomOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl?: string | null,
  ): Promise<EndpointValidationResult>;
  validateCustomAnthropicSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl?: string | null,
  ): Promise<EndpointValidationResult>;
}

export function createInferenceSelectionValidationHelpers(
  deps: InferenceSelectionValidationDeps,
): InferenceSelectionValidationHelpers {
  function printValidationFailure(label: string): void {
    console.error(`  ${label} endpoint validation failed.`);
    console.error("  Validation details were omitted to avoid exposing credentials.");
  }

  async function validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null = null,
    retryMessage = "Please choose a provider/model again.",
    helpUrl: string | null = null,
    options: {
      authMode?: "bearer" | "query-param";
      requireResponsesToolCalling?: boolean;
      requireChatCompletionsToolCalling?: boolean;
      skipResponsesProbe?: boolean;
      probeStreaming?: boolean;
      allowHostDockerInternal?: boolean;
    } = {},
  ): Promise<EndpointValidationResult> {
    const apiKey = credentialEnv ? getCredential(credentialEnv) : "";
    const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, options);
    if (!probe.ok) {
      printValidationFailure(label);
      if (deps.isNonInteractive()) {
        process.exit(1);
      }
      const retry = await deps.promptValidationRecovery(
        label,
        getProbeRecovery(probe),
        credentialEnv,
        helpUrl,
      );
      if (retry === "selection") {
        console.log(`  ${retryMessage}`);
        console.log("");
      }
      return { ok: false, retry };
    }
    if (probe.note) {
      console.log(`  ℹ ${probe.note}`);
    } else {
      console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
    }
    return { ok: true, api: probe.api ?? "openai-completions" };
  }

  async function validateAnthropicSelectionWithRetryMessage(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    retryMessage = "Please choose a provider/model again.",
    helpUrl: string | null = null,
  ): Promise<EndpointValidationResult> {
    const apiKey = getCredential(credentialEnv);
    const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
    if (!probe.ok) {
      printValidationFailure(label);
      if (deps.isNonInteractive()) {
        process.exit(1);
      }
      const retry = await deps.promptValidationRecovery(
        label,
        getProbeRecovery(probe),
        credentialEnv,
        helpUrl,
      );
      if (retry === "selection") {
        console.log(`  ${retryMessage}`);
        console.log("");
      }
      return { ok: false, retry };
    }
    console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
    return { ok: true, api: probe.api };
  }

  async function validateCustomOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null = null,
  ): Promise<EndpointValidationResult> {
    const apiKey = getCredential(credentialEnv);
    const probe = probeOpenAiLikeEndpoint(endpointUrl, model, apiKey, {
      requireResponsesToolCalling: true,
      skipResponsesProbe: shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
      probeStreaming: true,
    });
    if (probe.ok) {
      if (probe.note) {
        console.log(`  ℹ ${probe.note}`);
      } else {
        console.log(
          `  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`,
        );
      }
      return { ok: true, api: probe.api ?? "openai-completions" };
    }
    printValidationFailure(label);
    if (deps.isNonInteractive()) {
      process.exit(1);
    }
    const retry = await deps.promptValidationRecovery(
      label,
      getProbeRecovery(probe, { allowModelRetry: true }),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log("  Please choose a provider/model again.");
      console.log("");
    }
    return { ok: false, retry };
  }

  async function validateCustomAnthropicSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string,
    helpUrl: string | null = null,
  ): Promise<EndpointValidationResult> {
    const apiKey = getCredential(credentialEnv);
    const probe = probeAnthropicEndpoint(endpointUrl, model, apiKey);
    if (probe.ok) {
      console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
      return { ok: true, api: probe.api };
    }
    printValidationFailure(label);
    if (deps.isNonInteractive()) {
      process.exit(1);
    }
    const retry = await deps.promptValidationRecovery(
      label,
      getProbeRecovery(probe, { allowModelRetry: true }),
      credentialEnv,
      helpUrl,
    );
    if (retry === "selection") {
      console.log("  Please choose a provider/model again.");
      console.log("");
    }
    return { ok: false, retry };
  }

  return {
    validateOpenAiLikeSelection,
    validateAnthropicSelectionWithRetryMessage,
    validateCustomOpenAiLikeSelection,
    validateCustomAnthropicSelection,
  };
}
