// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellOptions, CaptureOpenshellResult } from "../adapters/openshell/client";
import { parseGatewayProviderNames } from "../credentials/provider-list";
import {
  buildOpenshellInferenceSetFailureMessage,
  OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
  openshellReportsProviderNotFound,
} from "./inference-set-error";

const OPEN_SHELL_DIAGNOSTIC_TIMEOUT_MS = 5_000;

interface ProviderDiagnosticDeps {
  captureOpenshell: (
    args: string[],
    opts?: Pick<CaptureOpenshellOptions, "ignoreError" | "maxBuffer" | "timeout">,
  ) => CaptureOpenshellResult;
  log: (message: string) => void;
}

export function queryRegisteredGatewayProviders(
  deps: ProviderDiagnosticDeps,
): string[] | undefined {
  try {
    const result = deps.captureOpenshell(["provider", "list", "--names"], {
      ignoreError: true,
      maxBuffer: OPEN_SHELL_FAILURE_CAPTURE_MAX_BUFFER,
      timeout: OPEN_SHELL_DIAGNOSTIC_TIMEOUT_MS,
    });
    if (result.status === 0) {
      return parseGatewayProviderNames(result.output).credentialNames;
    }
  } catch (_error: unknown) {
    // #5924: intentionally treat every thrown query or parsing error identically.
    // The provider-list lookup is secondary diagnostics; its error must not mask
    // the primary route failure, and the static warning below remains observable.
  }
  deps.log("  ⚠ Could not query registered OpenShell providers while formatting the failure.");
  return undefined;
}

export function buildInferenceSetFailure(
  setResult: CaptureOpenshellResult,
  provider: string,
  deps: ProviderDiagnosticDeps,
): { exitCode: number; message: string } {
  const stderr = typeof setResult.stderr === "string" ? setResult.stderr : "";
  const stdout = typeof setResult.stdout === "string" ? setResult.stdout : "";
  const providerNotFound = openshellReportsProviderNotFound(`${stderr}\n${stdout}`, provider);
  const exitCode = setResult.status ?? 1;
  return {
    exitCode,
    message: buildOpenshellInferenceSetFailureMessage({
      exitCode,
      providerNotFound,
      registeredProviders: providerNotFound ? queryRegisteredGatewayProviders(deps) : undefined,
      stderr,
      stdout,
    }),
  };
}
