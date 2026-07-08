// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingCredentialBindingPlan,
} from "./manifest";
import { normalizeProviderPlaceholderForEnvKey } from "./provider-placeholders";

export function hasFullPersistedCredentialBindingShape(
  binding: Partial<SandboxMessagingCredentialBindingPlan>,
): binding is SandboxMessagingCredentialBindingPlan {
  return (
    typeof binding.channelId === "string" &&
    typeof binding.credentialId === "string" &&
    typeof binding.sourceInput === "string" &&
    typeof binding.providerName === "string" &&
    typeof binding.providerEnvKey === "string" &&
    typeof binding.placeholder === "string" &&
    typeof binding.credentialAvailable === "boolean"
  );
}

export function normalizeFullPersistedCredentialBindings(
  bindings: readonly SandboxMessagingCredentialBindingPlan[],
): SandboxMessagingCredentialBindingPlan[] {
  return bindings.map((binding) => ({
    channelId: binding.channelId,
    credentialId: binding.credentialId,
    sourceInput: binding.sourceInput,
    providerName: binding.providerName,
    providerEnvKey: binding.providerEnvKey,
    placeholder:
      normalizeProviderPlaceholderForEnvKey(binding.placeholder, binding.providerEnvKey) ??
      binding.placeholder,
    credentialAvailable: binding.credentialAvailable === true,
    ...(typeof binding.credentialHash === "string"
      ? { credentialHash: binding.credentialHash }
      : {}),
  }));
}

export function normalizePersistedAgentCredentialPlaceholders(
  render: readonly SandboxMessagingAgentRenderPlan[],
  credentialBindings: readonly SandboxMessagingCredentialBindingPlan[],
): SandboxMessagingAgentRenderPlan[] {
  const credentialEnvKeys = new Set(
    credentialBindings.map((binding) => binding.providerEnvKey).filter(Boolean),
  );
  if (credentialEnvKeys.size === 0) return [...render];

  return render.map((entry) => {
    if (entry.kind !== "env-lines") return entry;
    return {
      ...entry,
      lines: entry.lines.map((line) => normalizeCredentialEnvLine(line, credentialEnvKeys)),
    };
  });
}

function normalizeCredentialEnvLine(line: string, credentialEnvKeys: ReadonlySet<string>): string {
  const index = line.indexOf("=");
  if (index <= 0) return line;
  const envKey = line.slice(0, index).trim();
  if (!credentialEnvKeys.has(envKey)) return line;
  const value = line.slice(index + 1);
  const normalized = normalizeProviderPlaceholderForEnvKey(value, envKey);
  return normalized ? `${envKey}=${normalized}` : line;
}
