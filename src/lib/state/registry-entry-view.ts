// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SandboxEntryViewInput {
  provider?: string | null;
  model?: string | null;
}

export type SandboxEntryInference =
  | { kind: "configured"; provider: string; model: string }
  | { kind: "unconfigured" };

export type SandboxEntryDisplayInference = {
  provider: string | null;
  model: string | null;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalDisplayString(value: string | null | undefined): string | null {
  return isNonEmptyString(value) ? value : null;
}

export function getSandboxEntryInference(entry: SandboxEntryViewInput): SandboxEntryInference {
  return isNonEmptyString(entry.provider) && isNonEmptyString(entry.model)
    ? { kind: "configured", provider: entry.provider, model: entry.model }
    : { kind: "unconfigured" };
}

export function getSandboxEntryDisplayInference(
  entry: SandboxEntryViewInput,
): SandboxEntryDisplayInference {
  const inference = getSandboxEntryInference(entry);
  return inference.kind === "configured"
    ? { provider: inference.provider, model: inference.model }
    : {
        provider: optionalDisplayString(entry.provider),
        model: optionalDisplayString(entry.model),
      };
}
