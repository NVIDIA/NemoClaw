// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface InferenceSelection {
  provider: string | null;
  model: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  nimContainer: string | null;
}

export type InferenceSelectionInput = Partial<InferenceSelection> | null | undefined;

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeInferenceSelection(input: InferenceSelectionInput): InferenceSelection {
  return {
    provider: nullableString(input?.provider),
    model: nullableString(input?.model),
    endpointUrl: nullableString(input?.endpointUrl),
    credentialEnv: nullableString(input?.credentialEnv),
    preferredInferenceApi: nullableString(input?.preferredInferenceApi),
    nimContainer: nullableString(input?.nimContainer),
  };
}

export function inferenceSelectionRegistryFields(
  input: InferenceSelectionInput,
): InferenceSelection {
  return normalizeInferenceSelection(input);
}
