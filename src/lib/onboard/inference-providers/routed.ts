// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Routed (blueprint profile, e.g. nvidia-router) inference setup flow.
// Extracted verbatim from onboard.setupInference (#767).

import type { RoutedDeps } from "./types";

export async function setupRoutedInference(
  args: {
    model: string;
    provider: string;
    endpointUrl: string | null;
    credentialEnv: string | null;
  },
  deps: RoutedDeps,
): Promise<{ done: false }> {
  const { model, provider, endpointUrl, credentialEnv } = args;
  const {
    runOpenshell,
    upsertProvider,
    reconcileModelRouter,
    routedInference,
    hydrateCredentialEnv,
    exitProcess,
    error,
    redact,
    compactText,
  } = deps;

  // Blueprint profile provider (e.g., nvidia-router for the routed profile).
  // reconcileModelRouter also probes sandbox→router reachability (#4564).
  try {
    await reconcileModelRouter();
  } catch (err) {
    error(`  ✗ Failed to start model router: ${err instanceof Error ? err.message : String(err)}`);
    return exitProcess(1);
  }
  const routed = routedInference.upsertRoutedProvider(provider, endpointUrl, credentialEnv, {
    upsertProvider,
    hydrateCredentialEnv,
  });
  if (!routed.ok) {
    error(`  ${routed.result.message}`);
    return exitProcess(routed.result.status || 1);
  }
  const applyResult = runOpenshell(
    ["inference", "set", "--no-verify", "--provider", provider, "--model", model],
    { ignoreError: true },
  );
  if (applyResult.status !== 0) {
    const message =
      compactText(redact(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`)) ||
      `Failed to configure inference provider '${provider}'.`;
    error(`  ${message}`);
    return exitProcess(applyResult.status || 1);
  }
  return { done: false };
}
