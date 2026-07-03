// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HOSTED_INFERENCE_CREDENTIAL_ENV,
  HOSTED_INFERENCE_PROVIDER_NAME,
} from "../hosted-inference.ts";
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
 * registry is authoritative for gateway/provider/model. Fresh registrations
 * may omit credentialEnv, so mirror production rebuild's canonical remote-
 * provider fallback instead of requiring that optional field. This deliberately
 * does not use NemoClawInstance.provider (the onboarding shorthand is "nvidia").
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
  const providerName = requiredRegistryString(entry, "provider");
  if (providerName !== HOSTED_INFERENCE_PROVIDER_NAME) {
    throw new Error(
      `dcode invalid-credential lifecycle requires provider '${HOSTED_INFERENCE_PROVIDER_NAME}', got '${providerName}'`,
    );
  }
  const credentialEnv =
    entry.credentialEnv === null || entry.credentialEnv === undefined
      ? HOSTED_INFERENCE_CREDENTIAL_ENV
      : requiredRegistryString(entry, "credentialEnv");
  if (credentialEnv !== HOSTED_INFERENCE_CREDENTIAL_ENV) {
    throw new Error(
      `dcode invalid-credential lifecycle requires credential env '${HOSTED_INFERENCE_CREDENTIAL_ENV}', got '${credentialEnv}'`,
    );
  }
  if (!isValidSecretEnvKey(credentialEnv)) {
    throw new Error(
      `dcode invalid-credential lifecycle registry credentialEnv '${credentialEnv}' is not a secret-bearing environment key`,
    );
  }
  return {
    gatewayName: requiredRegistryString(entry, "gatewayName"),
    providerName,
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
