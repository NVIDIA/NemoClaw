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
import { summarizeProbeForDisplay } from "./probe-diagnostics";
import { normalizeReasoningFlag } from "./reasoning-mode";

export type EndpointValidationResult =
  | { ok: true; api: string | null; retry?: undefined }
  | { ok: false; retry: "credential" | "selection" | "retry" | "model"; api?: undefined };

export interface InferenceSelectionValidationDeps {
  isNonInteractive(): boolean;
  agentProductName(): string;
  getCredential?: typeof getCredential;
  probeAnthropicEndpoint?: typeof probeAnthropicEndpoint;
  probeOpenAiLikeEndpoint?: typeof probeOpenAiLikeEndpoint;
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
  const resolveCredential = deps.getCredential ?? getCredential;
  const runAnthropicProbe = deps.probeAnthropicEndpoint ?? probeAnthropicEndpoint;
  const runOpenAiLikeProbe = deps.probeOpenAiLikeEndpoint ?? probeOpenAiLikeEndpoint;

  function exitNonInteractiveValidationFailure(): never {
    process.exitCode = 1;
    (process.exit as (code?: number) => void)(1);
    throw new Error("Non-interactive endpoint validation failed.");
  }

  function printValidationFailure(
    label: string,
    probe?: { failures?: unknown[]; message?: unknown },
  ): void {
    console.error(`  ${label} endpoint validation failed.`);
    if (probe) console.error(`  Validation probe summary: ${summarizeProbeForDisplay(probe)}.`);
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
    const apiKey = credentialEnv ? resolveCredential(credentialEnv) : "";
    const probe = runOpenAiLikeProbe(endpointUrl, model, apiKey, options);
    if (!probe.ok) {
      printValidationFailure(label, probe);
      if (deps.isNonInteractive()) {
        exitNonInteractiveValidationFailure();
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
    const apiKey = resolveCredential(credentialEnv);
    const probe = runAnthropicProbe(endpointUrl, model, apiKey);
    if (!probe.ok) {
      printValidationFailure(label, probe);
      if (deps.isNonInteractive()) {
        exitNonInteractiveValidationFailure();
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
    const apiKey = resolveCredential(credentialEnv);
    const reasoningEnabled = normalizeReasoningFlag(process.env.NEMOCLAW_REASONING) === "true";
    // Reasoning-only compatible endpoints often reject Responses, tool-call, and streaming probes.
    const probe = runOpenAiLikeProbe(endpointUrl, model, apiKey, {
      requireResponsesToolCalling: !reasoningEnabled,
      skipResponsesProbe:
        reasoningEnabled || shouldForceCompletionsApi(process.env.NEMOCLAW_PREFERRED_API),
      probeStreaming: !reasoningEnabled,
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
    printValidationFailure(label, probe);
    if (deps.isNonInteractive()) {
      exitNonInteractiveValidationFailure();
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
    const apiKey = resolveCredential(credentialEnv);
    const probe = runAnthropicProbe(endpointUrl, model, apiKey);
    if (probe.ok) {
      console.log(`  ${probe.label} available — ${deps.agentProductName()} will use ${probe.api}.`);
      return { ok: true, api: probe.api };
    }
    printValidationFailure(label, probe);
    if (deps.isNonInteractive()) {
      exitNonInteractiveValidationFailure();
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
