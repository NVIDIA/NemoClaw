// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidSecretEnvKey } from "../redaction.ts";

export interface DcodeInvalidCredentialRebuildOptions {
  gatewayName: string;
  providerName: string;
  credentialEnv: string;
  model: string;
  validCredential: string;
}

function requiredRegistryString(entry: Record<string, unknown>, field: string): string {
  const value = entry[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `dcode invalid-credential lifecycle requires registry field '${field}' to be a non-empty string`,
    );
  }
  return value.trim();
}

/**
 * Build destructive-test inputs from the persisted sandbox entry. The local
 * registry is authoritative for rebuild, so this deliberately does not use
 * NemoClawInstance.provider (the onboarding shorthand is "nvidia" while the
 * OpenShell provider is normally "compatible-endpoint").
 */
export function dcodeInvalidCredentialRebuildOptionsFromRegistryEntry(
  entry: Record<string, unknown>,
  validCredential: string,
): DcodeInvalidCredentialRebuildOptions {
  if (entry.agent !== "langchain-deepagents-code") {
    throw new Error(
      "dcode invalid-credential lifecycle requires a langchain-deepagents-code registry entry",
    );
  }
  if (!validCredential) {
    throw new Error("dcode invalid-credential lifecycle requires the original provider credential");
  }
  const credentialEnv = requiredRegistryString(entry, "credentialEnv");
  if (!isValidSecretEnvKey(credentialEnv)) {
    throw new Error(
      `dcode invalid-credential lifecycle registry credentialEnv '${credentialEnv}' is not a secret-bearing environment key`,
    );
  }
  return {
    gatewayName: requiredRegistryString(entry, "gatewayName"),
    providerName: requiredRegistryString(entry, "provider"),
    credentialEnv,
    model: requiredRegistryString(entry, "model"),
    validCredential,
  };
}

export function isDcodeInvalidCredentialRebuildOptions(
  options: object,
): options is DcodeInvalidCredentialRebuildOptions {
  return (
    "gatewayName" in options &&
    "providerName" in options &&
    "credentialEnv" in options &&
    "model" in options &&
    "validCredential" in options
  );
}
