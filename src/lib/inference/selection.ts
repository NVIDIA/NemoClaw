// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface InferenceSelection {
  provider: string | null;
  model: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  compatibleEndpointReasoning: "true" | "false" | null;
  nimContainer: string | null;
}

export type InferenceSelectionInput =
  | (Partial<Omit<InferenceSelection, "compatibleEndpointReasoning">> & {
      compatibleEndpointReasoning?: unknown;
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

function nullableBooleanString(value: unknown): "true" | "false" | null {
  return value === "true" || value === "false" ? value : null;
}

export function normalizeInferenceSelection(input: InferenceSelectionInput): InferenceSelection {
  return {
    provider: nullableString(input?.provider),
    model: nullableString(input?.model),
    endpointUrl: nullableString(input?.endpointUrl),
    credentialEnv: nullableString(input?.credentialEnv),
    preferredInferenceApi: nullableInferenceApi(input?.preferredInferenceApi),
    compatibleEndpointReasoning: nullableBooleanString(input?.compatibleEndpointReasoning),
    nimContainer: nullableString(input?.nimContainer),
  };
}

export function inferenceSelectionRegistryFields(
  input: InferenceSelectionInput,
): InferenceSelection {
  return normalizeInferenceSelection(input);
}
