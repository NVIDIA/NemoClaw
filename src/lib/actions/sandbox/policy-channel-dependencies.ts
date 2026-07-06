// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell } from "../../adapters/openshell/runtime";

type MessagingProviderTokenDefinition = {
  name: string;
  envKey: string;
  token: string | null;
  providerType?: string;
};

type MessagingProviderUpsertOptions = {
  replaceExisting?: boolean;
  bestEffort?: boolean;
};

type LegacyOnboardProvidersModule = {
  upsertMessagingProviders(
    tokenDefs: MessagingProviderTokenDefinition[],
    run: typeof runOpenshell,
    options?: MessagingProviderUpsertOptions,
  ): string[];
};

type RebuildModule = typeof import("./rebuild");

/**
 * Injectable, late-bound boundary around provider registration and rebuild
 * orchestration. Focused tests replace these methods with `vi.spyOn` without
 * using `createRequire` or mutating the CommonJS cache. This boundary can be
 * removed when those graphs can be imported without eagerly loading unrelated
 * onboarding and rebuild modules at policy-channel import time.
 */
export const policyChannelDependencies = {
  upsertMessagingProviders(
    tokenDefs: MessagingProviderTokenDefinition[],
    options?: MessagingProviderUpsertOptions,
  ): string[] {
    const providers = require("../../onboard/providers") as LegacyOnboardProvidersModule;
    return providers.upsertMessagingProviders(tokenDefs, runOpenshell, options);
  },
  rebuildSandbox(
    sandboxName: Parameters<RebuildModule["rebuildSandbox"]>[0],
    args: Parameters<RebuildModule["rebuildSandbox"]>[1],
  ): ReturnType<RebuildModule["rebuildSandbox"]> {
    const rebuild = require("./rebuild") as RebuildModule;
    return rebuild.rebuildSandbox(sandboxName, args);
  },
};
