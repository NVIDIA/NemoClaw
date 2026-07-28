// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeReasoningEffort, type ReasoningEffort } from "../onboard/reasoning-mode";

export {
  type ReasoningEffortRequest,
  resolveReasoningEffortRequest,
} from "../onboard/reasoning-mode";

export type InferenceEndpointSource = "onboard" | "inference-set";

export interface InferenceSelection {
  provider: string | null;
  model: string | null;
  endpointUrl: string | null;
  endpointSource?: InferenceEndpointSource | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: "true" | "false" | null;
  compatibleEndpointReasoningEffort: ReasoningEffort | null;
  nimContainer: string | null;
}

export type EffectiveReasoningEffort = ReasoningEffort | "endpoint-default";

export type InferenceSelectionInput =
  | (Partial<
      Omit<InferenceSelection, "compatibleEndpointReasoning" | "compatibleEndpointReasoningEffort">
    > & {
      compatibleEndpointReasoning?: unknown;
      compatibleEndpointReasoningEffort?: unknown;
    })
  | null
  | undefined;

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const SUPPORTED_INFERENCE_APIS = new Set([
  "openai-completions",
  "anthropic-messages",
  "openai-responses",
]);

function nullableInferenceApi(value: unknown): string | null {
  const normalized = nullableString(value);
  return normalized && SUPPORTED_INFERENCE_APIS.has(normalized) ? normalized : null;
}

export function normalizeInferenceEndpointSource(value: unknown): InferenceEndpointSource | null {
  return value === "onboard" || value === "inference-set" ? value : null;
}

function nullableCompatibleEndpointReasoning(
  provider: string | null,
  value: unknown,
): "true" | "false" | null {
  if (provider !== "compatible-endpoint") return null;
  const normalized = nullableString(value)?.toLowerCase();
  return normalized === "true" || normalized === "false" ? normalized : null;
}

function nullableCompatibleEndpointReasoningEffort(
  provider: string | null,
  value: unknown,
): ReasoningEffort | null {
  if (provider !== "compatible-endpoint") return null;
  return normalizeReasoningEffort(value);
}

export function normalizeInferenceSelection(input: InferenceSelectionInput): InferenceSelection {
  const provider = nullableString(input?.provider);
  const endpointUrl = nullableString(input?.endpointUrl);
  return {
    provider,
    model: nullableString(input?.model),
    endpointUrl,
    endpointSource: endpointUrl ? normalizeInferenceEndpointSource(input?.endpointSource) : null,
    credentialEnv: nullableString(input?.credentialEnv),
    preferredInferenceApi: nullableInferenceApi(input?.preferredInferenceApi),
    compatibleEndpointReasoning: nullableCompatibleEndpointReasoning(
      provider,
      input?.compatibleEndpointReasoning,
    ),
    compatibleEndpointReasoningEffort: nullableCompatibleEndpointReasoningEffort(
      provider,
      input?.compatibleEndpointReasoningEffort,
    ),
    nimContainer: nullableString(input?.nimContainer),
  };
}

/**
 * Return the non-secret reasoning-effort setting that actually applies to a
 * compatible OpenAI Completions route. An absent override delegates to the
 * endpoint instead of silently looking like an unknown value.
 */
export function getEffectiveReasoningEffort(
  input:
    | Partial<
        Pick<
          InferenceSelection,
          "provider" | "preferredInferenceApi" | "compatibleEndpointReasoningEffort"
        >
      >
    | null
    | undefined,
): EffectiveReasoningEffort | null {
  const selection = normalizeInferenceSelection(input);
  if (
    selection.provider !== "compatible-endpoint" ||
    selection.preferredInferenceApi !== "openai-completions"
  ) {
    return null;
  }
  return selection.compatibleEndpointReasoningEffort ?? "endpoint-default";
}

export function inferenceSelectionRegistryFields(
  input: InferenceSelectionInput,
): InferenceSelection {
  return normalizeInferenceSelection(input);
}
