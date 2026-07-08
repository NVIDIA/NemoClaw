// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RebuildDurableConfig } from "./rebuild-durable-config";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";

type RebuildAuthoritativePreflightOptions = RebuildRecreateOnboardOpts & {
  deferInferenceRouteUntilOnboard?: true;
  model: string;
  provider: string;
  sandboxName: string;
};

type RebuildOnboardModule = {
  ensureValidatedWebSearchCredential: (
    config: NonNullable<RebuildDurableConfig["webSearchConfig"]>,
    nonInteractive?: boolean,
  ) => Promise<unknown>;
  hydrateCredentialEnv: (name: string) => string | null;
  onboard: (options: RebuildRecreateOnboardOpts) => Promise<void>;
  preflightAuthoritativeRebuildTarget: (
    options: RebuildAuthoritativePreflightOptions,
  ) => Promise<void>;
};

function loadOnboardModule(): RebuildOnboardModule {
  return require("../../onboard") as RebuildOnboardModule;
}

/**
 * Late-bound onboarding boundary for rebuild orchestration. Rebuild imports no
 * longer initialize the full onboarding graph, and focused tests can replace
 * these calls without mutating the CommonJS cache. Remove this boundary once
 * the onboarding APIs are side-effect-free named imports.
 */
export const rebuildOnboardDependencies = {
  ensureValidatedWebSearchCredential(
    config: NonNullable<RebuildDurableConfig["webSearchConfig"]>,
    nonInteractive?: boolean,
  ): Promise<unknown> {
    return loadOnboardModule().ensureValidatedWebSearchCredential(config, nonInteractive);
  },
  hydrateCredentialEnv(name: string): string | null {
    return loadOnboardModule().hydrateCredentialEnv(name);
  },
  onboard(options: RebuildRecreateOnboardOpts): Promise<void> {
    return loadOnboardModule().onboard(options);
  },
  preflightAuthoritativeRebuildTarget(
    options: RebuildAuthoritativePreflightOptions,
  ): Promise<void> {
    return loadOnboardModule().preflightAuthoritativeRebuildTarget(options);
  },
};
