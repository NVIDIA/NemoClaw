// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "./registry";

export type SandboxEntryInference =
  | { kind: "configured"; provider: string; model: string }
  | { kind: "unconfigured" };

export type SandboxGatewayBinding =
  | { kind: "registered"; gatewayName: string; gatewayPort: number }
  | { kind: "missing" };

export interface NormalizedSandboxEntry {
  name: string;
  raw: SandboxEntry;
  inference: SandboxEntryInference;
  gateway: SandboxGatewayBinding;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTcpPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function getSandboxEntryInference(entry: SandboxEntry): SandboxEntryInference {
  return isNonEmptyString(entry.provider) && isNonEmptyString(entry.model)
    ? { kind: "configured", provider: entry.provider, model: entry.model }
    : { kind: "unconfigured" };
}

export function getSandboxEntryGatewayBinding(entry: SandboxEntry): SandboxGatewayBinding {
  return isNonEmptyString(entry.gatewayName) && isValidTcpPort(entry.gatewayPort)
    ? { kind: "registered", gatewayName: entry.gatewayName, gatewayPort: entry.gatewayPort }
    : { kind: "missing" };
}

export function normalizeSandboxEntryView(entry: SandboxEntry): NormalizedSandboxEntry {
  return {
    name: entry.name,
    raw: entry,
    inference: getSandboxEntryInference(entry),
    gateway: getSandboxEntryGatewayBinding(entry),
  };
}
