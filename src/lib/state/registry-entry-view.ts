// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SandboxEntryViewInput {
  name: string;
  provider?: string | null;
  model?: string | null;
  gatewayName?: string | null;
  gatewayPort?: number | null;
}

export type SandboxEntryInference =
  | { kind: "configured"; provider: string; model: string }
  | { kind: "unconfigured" };

export type SandboxEntryDisplayInference = {
  provider: string | null;
  model: string | null;
};

export type SandboxGatewayBinding =
  | { kind: "registered"; gatewayName: string; gatewayPort: number }
  | { kind: "missing" };

export interface NormalizedSandboxEntry<
  Entry extends SandboxEntryViewInput = SandboxEntryViewInput,
> {
  name: string;
  raw: Entry;
  inference: SandboxEntryInference;
  gateway: SandboxGatewayBinding;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalDisplayString(value: string | null | undefined): string | null {
  return isNonEmptyString(value) ? value : null;
}

function isValidTcpPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function getSandboxEntryInference(entry: SandboxEntryViewInput): SandboxEntryInference {
  return isNonEmptyString(entry.provider) && isNonEmptyString(entry.model)
    ? { kind: "configured", provider: entry.provider, model: entry.model }
    : { kind: "unconfigured" };
}

export function getSandboxEntryGatewayBinding(entry: SandboxEntryViewInput): SandboxGatewayBinding {
  return isNonEmptyString(entry.gatewayName) && isValidTcpPort(entry.gatewayPort)
    ? { kind: "registered", gatewayName: entry.gatewayName, gatewayPort: entry.gatewayPort }
    : { kind: "missing" };
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

export function normalizeSandboxEntryView<Entry extends SandboxEntryViewInput>(
  entry: Entry,
): NormalizedSandboxEntry<Entry> {
  return {
    name: entry.name,
    raw: entry,
    inference: getSandboxEntryInference(entry),
    gateway: getSandboxEntryGatewayBinding(entry),
  };
}
