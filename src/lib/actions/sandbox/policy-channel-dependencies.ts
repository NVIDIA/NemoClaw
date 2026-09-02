// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { inspectOpenShellSandboxIdentityFingerprint } from "../../adapters/openshell/policy-state";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import { runOpenshell } from "../../adapters/openshell/runtime";
import { namedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { getCredential, normalizeCredentialValue } from "../../credentials/store";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  isMessagingProviderBindingConflict as isTypedMessagingProviderBindingConflict,
  isMessagingProviderMutationFailure as isTypedMessagingProviderMutationFailure,
} from "../../messaging/applier/openshell-provider";
import { buildMessagingProviderApplication } from "../../messaging/applier/provider-application";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../../messaging/manifest";

type MessagingProviderTokenDefinition = {
  name: string;
  envKey: string;
  token: string | null;
  providerType?: string;
  additionalCredentials?: Array<{ envKey: string; token: string | null }>;
};

type MessagingProviderUpsertOptions = {
  replaceExisting?: boolean;
  bestEffort?: boolean;
  requireExactBindings?: boolean;
};

type LegacyOnboardProvidersModule = {
  isMessagingProviderBindingConflict(error: unknown): error is Error & {
    readonly mutatedProviderNames: readonly string[];
    readonly createdProviderNames?: readonly string[];
  };
  isMessagingProviderMutationFailure(error: unknown): error is Error & {
    readonly mutatedProviderNames: readonly string[];
    readonly createdProviderNames: readonly string[];
  };
  upsertMessagingProviders(
    tokenDefs: MessagingProviderTokenDefinition[],
    run: typeof runOpenshell,
    options?: MessagingProviderUpsertOptions,
  ): string[];
};

type RebuildModule = typeof import("./rebuild");
type SetupInferenceModule = typeof import("../../onboard/setup-inference");
type SandboxProviderCleanupModule = typeof import("../../onboard/sandbox-provider-cleanup");
type PolicyModule = typeof import("../../policy");
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

function gatewayRunner(gatewayName: string): typeof runOpenshell {
  const { createGatewayScopedOpenshellRunner } =
    require("../../onboard/setup-inference") as SetupInferenceModule;
  return createGatewayScopedOpenshellRunner(runOpenshell, gatewayName);
}

/**
 * Injectable, late-bound boundary around provider registration and rebuild
 * orchestration. Focused tests replace these methods with `vi.spyOn` without
 * using `createRequire` or mutating the CommonJS cache. This boundary can be
 * removed when those graphs can be imported without eagerly loading unrelated
 * onboarding and rebuild modules at policy-channel import time.
 */
export const policyChannelDependencies = {
  deleteMessagingProviderWithRecovery(
    providerName: string,
    sandboxName: string,
    gatewayName: string,
  ): ReturnType<SandboxProviderCleanupModule["deleteProviderWithRecovery"]> {
    const cleanup =
      require("../../onboard/sandbox-provider-cleanup") as SandboxProviderCleanupModule;
    return cleanup.deleteProviderWithRecovery(providerName, {
      allowedSandboxes: [sandboxName],
      runOpenshell: gatewayRunner(gatewayName),
    });
  },
  revalidateChannelProviderPolicy(sandboxName: string, gatewayName: string): void {
    const policy = require("../../policy") as PolicyModule;
    const operation = `change messaging providers for sandbox '${sandboxName}'`;
    const context = policy.inspectPolicyMutationContext(sandboxName, operation, gatewayName);
    policy.recheckPolicyMutationContext(sandboxName, operation, context);
  },
  runGatewayOpenshell(
    gatewayName: string,
    args: Parameters<typeof runOpenshell>[0],
    options?: Parameters<typeof runOpenshell>[1],
  ): ReturnType<typeof runOpenshell> {
    return gatewayRunner(gatewayName)(args, options);
  },
  inspectMessagingProviderAttachmentTarget(sandboxName: string, gatewayName: string): string {
    return inspectOpenShellSandboxIdentityFingerprint({
      sandboxName,
      gatewayName,
    });
  },
  isMessagingProviderBindingConflict(error: unknown): error is Error & {
    readonly mutatedProviderNames: readonly string[];
    readonly createdProviderNames?: readonly string[];
  } {
    if (isTypedMessagingProviderBindingConflict(error)) return true;
    const providers = require("../../onboard/providers") as LegacyOnboardProvidersModule;
    return providers.isMessagingProviderBindingConflict(error);
  },
  isMessagingProviderMutationFailure(error: unknown): error is Error & {
    readonly mutatedProviderNames: readonly string[];
    readonly createdProviderNames: readonly string[];
  } {
    if (isTypedMessagingProviderMutationFailure(error)) return true;
    const providers = require("../../onboard/providers") as LegacyOnboardProvidersModule;
    return providers.isMessagingProviderMutationFailure(error);
  },
  async attachMessagingProvider(
    providerName: string,
    sandboxName: string,
    gatewayName: string,
  ): Promise<void> {
    const result = await createCliOpenShellProviderAdapter().attachProvider({
      target: namedOpenShellGateway(gatewayName),
      providerName,
      sandboxName,
    });
    if (!result.ok) {
      throw new Error(
        `OpenShell did not attach messaging provider '${providerName}' to sandbox '${sandboxName}': ${result.error.message}`,
      );
    }
  },
  async deleteMessagingProvider(providerName: string, gatewayName: string): Promise<boolean> {
    const result = await createCliOpenShellProviderAdapter().deleteProvider({
      target: namedOpenShellGateway(gatewayName),
      providerName,
    });
    return (
      result.ok ||
      (result.error.kind === "command" && result.error.reason === "not_found")
    );
  },
  upsertMessagingProviders(
    tokenDefs: MessagingProviderTokenDefinition[],
    gatewayName: string,
    options?: MessagingProviderUpsertOptions,
    context?: {
      readonly plan: SandboxMessagingPlan;
      readonly channelName: string;
      readonly sandboxAgent: string | null | undefined;
    },
  ): string[] | Promise<string[]> {
    if (!context) return Promise.reject(new Error("Messaging provider application context is missing."));
    const application = buildMessagingProviderApplication({
      tokenDefs,
      root: REPOSITORY_ROOT,
      agent: context.sandboxAgent,
      getCredential,
      env: process.env,
      normalizeCredentialValue: (value) =>
        normalizeCredentialValue(value as string | undefined),
      channelIdForCredential: () => context.channelName,
    });
    if (application.otherTokenDefs.length > 0) {
      return Promise.reject(new Error("Channel add produced a non-messaging provider definition."));
    }
    return MessagingSetupApplier.applyCredentialsAtOpenShell(context.plan, {
      providerAdapter: createCliOpenShellProviderAdapter(),
      target: namedOpenShellGateway(gatewayName),
      definitions: application.definitions,
      refreshes: application.refreshes,
      bestEffort: options?.bestEffort,
      log: (message) => console.error(`  ${message}`),
    }).then((result) => [...result.providerNames]);
  },
  rebuildSandbox(
    sandboxName: Parameters<RebuildModule["rebuildSandbox"]>[0],
    args: Parameters<RebuildModule["rebuildSandbox"]>[1],
  ): ReturnType<RebuildModule["rebuildSandbox"]> {
    const rebuild = require("./rebuild") as RebuildModule;
    return rebuild.rebuildSandbox(sandboxName, args);
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
