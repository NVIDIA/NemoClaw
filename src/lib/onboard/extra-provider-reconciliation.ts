// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNoOpenShellGatewayEndpointOverride } from "../openshell-gateway-endpoint-guard";

type ExtraProviderRunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type ReconcileExtraProvidersDeps = {
  runOpenshell?: ExtraProviderRunOpenshell;
  listExtraProviders?: () => string[];
};

function defaultRunOpenshell(
  args: string[],
  opts?: Record<string, unknown>,
): ReturnType<ExtraProviderRunOpenshell> {
  const runtime = require("../adapters/openshell/runtime") as {
    runOpenshell: ExtraProviderRunOpenshell;
  };
  return runtime.runOpenshell(args, opts);
}

function defaultListExtraProviders(): string[] {
  const { listExtraProviders } = require("../state/registry") as {
    listExtraProviders: () => string[];
  };
  return listExtraProviders();
}

function outputText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  return value?.toString() ?? "";
}

/**
 * Reconcile user-owned registry extras with one authoritative gateway list (#6501).
 *
 * A successful list is safe to filter against because provider names are matched
 * exactly; there are no reserved search-provider names or diagnostic heuristics.
 * A failed or thrown list preserves every recorded name so an unavailable gateway
 * cannot silently change sandbox-create intent. Local registry state is never
 * mutated: a provider omitted for this create remains available for later retry.
 */
export function reconcileRegisteredExtraProviders(
  gatewayName: string,
  deps: ReconcileExtraProvidersDeps = {},
): string[] {
  const recorded = (deps.listExtraProviders ?? defaultListExtraProviders)();
  if (recorded.length === 0) return recorded;
  if (!gatewayName) throw new Error("OpenShell gateway name is required.");
  assertNoOpenShellGatewayEndpointOverride();

  const runOpenshell = deps.runOpenshell ?? defaultRunOpenshell;
  let result: ReturnType<ExtraProviderRunOpenshell>;
  try {
    result = runOpenshell(["provider", "list", "-g", gatewayName, "--names"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    });
  } catch {
    return recorded;
  }
  if (result.status !== 0) return recorded;

  const gatewayNames = new Set(
    outputText(result.stdout)
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  return recorded.filter((name) => gatewayNames.has(name));
}
