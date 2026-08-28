// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshell as defaultRunOpenshell } from "../../adapters/openshell/runtime";
import {
  isPolicyAuthorityRefusalError,
  preflightSandboxPolicyAuthority,
} from "./policy-authority/preflight";

type MessagingProviderTokenDefinition = {
  name: string;
  envKey: string;
  token: string | null;
  providerType?: string;
};

type MessagingProviderUpsertOptions = {
  replaceExisting?: boolean;
  bestEffort?: boolean;
  revalidatePolicyRequirements?(operation: string): void;
  requireExactBindings?: boolean;
};

type LegacyOnboardProvidersModule = {
  isMessagingProviderBindingConflict(
    error: unknown,
  ): error is Error & { readonly mutatedProviderNames: readonly string[] };
  upsertMessagingProviders(
    tokenDefs: MessagingProviderTokenDefinition[],
    run: typeof defaultRunOpenshell,
    options?: MessagingProviderUpsertOptions,
  ): string[];
};

type RebuildModule = typeof import("./rebuild");
type StopModule = typeof import("./stop");
type GooglechatWebhookLifecycleModule =
  typeof import("../../messaging/channels/googlechat/tunnel/lifecycle");
type GooglechatTunnelRuntimeDeps =
  import("../../messaging/channels/googlechat/hooks/tunnel-runtime").GooglechatTunnelRuntimeDeps;
type GooglechatTunnelServices = Pick<
  typeof import("../../tunnel/services"),
  "getTunnelUrl" | "readCloudflaredState" | "resolveServicePidDir" | "startAll" | "stopCloudflared"
>;
type GooglechatWebhookProxy = Pick<
  typeof import("../../messaging/channels/googlechat/tunnel/proxy"),
  "readGooglechatWebhookProxyState" | "startGooglechatWebhookProxy" | "stopGooglechatWebhookProxy"
>;

/**
 * Injectable, late-bound boundary around provider registration and rebuild
 * orchestration. Focused tests replace these methods with `vi.spyOn` without
 * using `createRequire` or mutating the CommonJS cache. This boundary can be
 * removed when those graphs can be imported without eagerly loading unrelated
 * onboarding and rebuild modules at policy-channel import time.
 */
export const policyChannelDependencies = {
  isPolicyAuthorityRefusalError,
  preflightSandboxPolicyAuthority,
  runOpenshell: (...args: Parameters<typeof defaultRunOpenshell>) => defaultRunOpenshell(...args),
  isMessagingProviderBindingConflict(
    error: unknown,
  ): error is Error & { readonly mutatedProviderNames: readonly string[] } {
    const providers = require("../../onboard/providers") as LegacyOnboardProvidersModule;
    return providers.isMessagingProviderBindingConflict(error);
  },
  upsertMessagingProviders(
    tokenDefs: MessagingProviderTokenDefinition[],
    options?: MessagingProviderUpsertOptions,
  ): string[] {
    const providers = require("../../onboard/providers") as LegacyOnboardProvidersModule;
    return providers.upsertMessagingProviders(tokenDefs, defaultRunOpenshell, options);
  },
  rebuildSandbox(
    sandboxName: Parameters<RebuildModule["rebuildSandbox"]>[0],
    args: Parameters<RebuildModule["rebuildSandbox"]>[1],
  ): ReturnType<RebuildModule["rebuildSandbox"]> {
    const rebuild = require("./rebuild") as RebuildModule;
    return rebuild.rebuildSandbox(sandboxName, args);
  },
  stopSandbox(
    sandboxName: Parameters<StopModule["stopSandbox"]>[0],
  ): ReturnType<StopModule["stopSandbox"]> {
    const stop = require("./stop") as StopModule;
    return stop.stopSandbox(sandboxName);
  },
  stopGooglechatWebhookTunnel(sandboxName: string): void {
    const lifecycle =
      require("../../messaging/channels/googlechat/tunnel/lifecycle") as GooglechatWebhookLifecycleModule;
    const services = require("../../tunnel/services") as GooglechatTunnelServices;
    const webhookProxy =
      require("../../messaging/channels/googlechat/tunnel/proxy") as GooglechatWebhookProxy;
    lifecycle.stopGooglechatWebhookTunnel(sandboxName, { services, webhookProxy });
  },
  googlechatTunnelRuntime(sandboxName: string): GooglechatTunnelRuntimeDeps {
    return {
      sandboxName,
      loadServices: () => require("../../tunnel/services") as GooglechatTunnelServices,
      loadWebhookProxy: () =>
        require("../../messaging/channels/googlechat/tunnel/proxy") as GooglechatWebhookProxy,
      prompt: (question) => {
        const store =
          require("../../credentials/store") as typeof import("../../credentials/store");
        return store.prompt(question);
      },
    };
  },
};
