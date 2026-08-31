// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellResult } from "../adapters/openshell/client";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { selectedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import { classifyGatewayProviderNames } from "../credentials/provider-list";
import {
  buildOpenshellInferenceSetFailureMessage,
  openshellReportsProviderNotFound,
} from "./inference-set-error";

const OPEN_SHELL_DIAGNOSTIC_TIMEOUT_MS = 5_000;

interface ProviderDiagnosticDeps {
  providerAdapter: OpenShellProviderAdapter;
  log: (message: string) => void;
}

export async function queryRegisteredGatewayProviders(
  deps: ProviderDiagnosticDeps,
): Promise<string[] | undefined> {
  try {
    const result = await deps.providerAdapter.listProviders({
      target: selectedOpenShellGateway(),
      timeoutMs: OPEN_SHELL_DIAGNOSTIC_TIMEOUT_MS,
    });
    if (result.ok) {
      return classifyGatewayProviderNames(result.value.names).credentialNames;
    }
  } catch (_error: unknown) {
    // #5924: intentionally treat every thrown query or parsing error identically.
    // The provider-list lookup is secondary diagnostics; its error must not mask
    // the primary route failure, and the static warning below remains observable.
  }
  deps.log("  ⚠ Could not query registered OpenShell providers while formatting the failure.");
  return undefined;
}

export async function buildInferenceSetFailure(
  setResult: CaptureOpenshellResult,
  provider: string,
  deps: ProviderDiagnosticDeps,
): Promise<{ exitCode: number; message: string }> {
  const stderr = typeof setResult.stderr === "string" ? setResult.stderr : "";
  const stdout = typeof setResult.stdout === "string" ? setResult.stdout : "";
  const providerNotFound = openshellReportsProviderNotFound(`${stderr}\n${stdout}`, provider);
  const exitCode = setResult.status ?? 1;
  return {
    exitCode,
    message: buildOpenshellInferenceSetFailureMessage({
      exitCode,
      providerNotFound,
      registeredProviders: providerNotFound
        ? await queryRegisteredGatewayProviders(deps)
        : undefined,
      stderr,
      stdout,
    }),
  };
}
