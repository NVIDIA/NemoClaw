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
  } = deps;

  // Blueprint profile provider (e.g., nvidia-router for the routed profile).
  // reconcileModelRouter also probes sandbox→router reachability (#4564).
  try {
    await reconcileModelRouter();
  } catch (err) {
    console.error(
      `  ✗ Failed to start model router: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  const routed = routedInference.upsertRoutedProvider(provider, endpointUrl, credentialEnv, {
    upsertProvider,
    hydrateCredentialEnv,
  });
  if (!routed.ok) {
    console.error(`  ${routed.result.message}`);
    process.exit(routed.result.status || 1);
  }
  runOpenshell(["inference", "set", "--no-verify", "--provider", provider, "--model", model]);
  return { done: false };
}
