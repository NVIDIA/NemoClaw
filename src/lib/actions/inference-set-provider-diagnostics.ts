// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CaptureOpenshellOptions, CaptureOpenshellResult } from "../adapters/openshell/client";
import { parseGatewayProviderNames } from "../credentials/provider-list";

const OPEN_SHELL_DIAGNOSTIC_MAX_BUFFER = 64 * 1024;
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
      maxBuffer: OPEN_SHELL_DIAGNOSTIC_MAX_BUFFER,
      timeout: OPEN_SHELL_DIAGNOSTIC_TIMEOUT_MS,
    });
    if (result.status === 0) {
      return parseGatewayProviderNames(result.output).credentialNames;
    }
  } catch {
    // #5924: diagnostics must never replace or expose details from the original
    // route failure, so every provider-query failure uses the same static fallback.
  }
  deps.log("  ⚠ Could not query registered OpenShell providers while formatting the failure.");
  return undefined;
}
