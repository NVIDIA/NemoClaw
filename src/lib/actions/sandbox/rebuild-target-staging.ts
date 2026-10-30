// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveAgentProviderInferenceApi } from "../../inference/anthropic/openai-surface";
import { isBedrockRuntimeEndpoint } from "../../inference/bedrock-runtime";
import {
  isPersistedPiSharedLocalInferenceRoute,
  usesNativeLocalInferenceForAgent,
} from "../../inference/native-local/eligibility";
import { fixedNativeProvider } from "../../inference/native-provider/fixed";
import { usesCustomNativeOnboarding } from "../../inference/native-provider/custom-setup";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import {
  canResumeInferenceRoute,
  localInferenceRouteTimeoutError,
  shouldRefreshCompatibleEndpointRouteForMessaging,
} from "../../onboard/local-inference-route";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import type { RebuildTargetConfig } from "./rebuild-target-config";
import { hydrateMessagingChannelConfig } from "../../messaging-channel-config";
import {
  isN1xManagedVllmProviderModel,
  isRecordedN1xManagedVllmRebuildEligible,
} from "../../domain/sandbox/n1x-managed-vllm-rebuild";
import {
  isN1xOnboardingProviderKey,
  persistedProviderNameToSelectionKey,
  type RemoteProviderConfigEntryLike,
} from "../../onboard/inference-providers/provider-selection-keys";
import { getStoredMessagingChannelConfig } from "../../onboard/messaging-config";
import {
  createRebuildRouteHandoff,
  type RegistryInferenceRoute,
} from "../../onboard/rebuild-route-handoff";
import { parseHostLocalInferenceReceipt } from "../../onboard/runtime-provider/host-local-inference";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import * as onboardSession from "../../state/onboard-session";
import type { RebuildBail } from "./rebuild-credential-preflight";
import {
  REBUILD_HERMES_DASHBOARD_ENV_KEYS,
  resolveRebuildHermesDashboardEnv,
} from "./rebuild-durable-config";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import {
  buildRebuildRecreateOnboardOpts,
  type RebuildRecreateOnboardOpts,
} from "./rebuild-gpu-opt-out";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";

const { REMOTE_PROVIDER_CONFIG } = require("../../onboard/providers") as {
  REMOTE_PROVIDER_CONFIG: Record<string, RemoteProviderConfigEntryLike>;
};

export function prepareRebuildRecreateOptions(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  rebuildAgent: string | null,
  storedFromDockerfile: string | null,
  storedFromImage: string | null,
  registryInferenceRoute: RegistryInferenceRoute | null,
  autoYes: boolean,
  baseImageResolutionHint: SandboxBaseImageResolutionMetadata | null,
  bail: RebuildBail,
): RebuildRecreateOnboardOpts | null {
  try {
    const options = buildRebuildRecreateOnboardOpts({
      sb,
      rebuildAgent,
      storedFromDockerfile,
      storedFromImage,
      autoYes,
      baseImageResolutionHint,
      usageNoticeAccepted: true,
    });
    return registryInferenceRoute
      ? {
          ...options,
          rebuildRegistryInferenceRoute: createRebuildRouteHandoff(
            sandboxName,
            registryInferenceRoute,
          ),
        }
      : options;
  } catch (err) {
    printRebuildPreflightFailure(
      "the recorded recreate target is invalid.",
      err instanceof Error ? err.message : String(err),
      "Recorded recreate target is invalid",
      bail,
    );
    return null;
  }
}

export function stageRebuildHermesDashboardConfig(
  rebuildAgent: string | null,
  sb: RebuildSandboxEntry,
  controlUiPort: number | null,
  bail: RebuildBail,
): boolean {
  const resolved = resolveRebuildHermesDashboardEnv(rebuildAgent, sb, controlUiPort);
  if (!resolved.ok) {
    printRebuildPreflightFailure(
      "the recorded Hermes dashboard state is invalid.",
      resolved.reason,
      "Recorded Hermes dashboard state is invalid",
      bail,
    );
    return false;
  }
  for (const key of REBUILD_HERMES_DASHBOARD_ENV_KEYS) {
    const value = resolved.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return true;
}

/** Stage a validated recorded N1x provider decision for authoritative rebuild readiness. */
export function stageRecordedDeferredN1xIntent(
  recreateOptions: Pick<
    RebuildRecreateOnboardOpts,
    "allowDeferredN1xManagedVllm" | "reinstallDeferredN1xManagedVllm"
  >,
  sandboxEntry: Pick<
    RebuildSandboxEntry,
    | "provider"
    | "model"
    | "endpointUrl"
    | "endpointSource"
    | "openshellDriver"
    | "hostLocalInferenceReceipt"
    | "deferredN1xManagedVllmAccepted"
    | "nimContainer"
  >,
  rebuildSelection: {
    provider: string;
    model: string;
    pinEndpoint: boolean;
    endpointUrl: string | null;
  },
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const explicitPreviewIntent = String(env.NEMOCLAW_PROVIDER ?? "").trim() === "install-vllm";
  const selectionMatchesRecord =
    rebuildSelection.provider === sandboxEntry.provider &&
    rebuildSelection.model === sandboxEntry.model;
  const isManagedVllmIdentity = isN1xManagedVllmProviderModel(
    sandboxEntry.provider,
    sandboxEntry.model,
  );
  const recordedStandardProviderIsEligible =
    selectionMatchesRecord &&
    !isManagedVllmIdentity &&
    isN1xOnboardingProviderKey(
      persistedProviderNameToSelectionKey(
        sandboxEntry.provider,
        { hasNimContainer: Boolean(sandboxEntry.nimContainer) },
        REMOTE_PROVIDER_CONFIG,
      ),
    );
  const recordedManagedVllmIsEligible =
    !sandboxEntry.nimContainer &&
    isRecordedN1xManagedVllmRebuildEligible(
      sandboxEntry,
      rebuildSelection,
      parseHostLocalInferenceReceipt,
      {
        explicitPreviewIntent,
      },
    );
  if (recordedStandardProviderIsEligible || recordedManagedVllmIsEligible) {
    recreateOptions.allowDeferredN1xManagedVllm = true;
  }
  if (recordedManagedVllmIsEligible && explicitPreviewIntent) {
    recreateOptions.reinstallDeferredN1xManagedVllm = true;
  }
}

export function hydrateMessagingConfigForRebuild(
  sandboxName: string,
  log: (msg: string) => void,
): void {
  const rebuildSession = onboardSession.loadSession();
  const hydratedMessagingConfig = hydrateMessagingChannelConfig(
    getStoredMessagingChannelConfig(sandboxName, rebuildSession),
  );
  if (hydratedMessagingConfig) {
    log(`Stashed messaging config for rebuild: ${Object.keys(hydratedMessagingConfig).join(",")}`);
  }
}

/** Resolve the resumed route before a rebuild can stop or delete its source. */
export function rebuildInferenceRouteTimeoutError(
  target: RebuildTargetConfig,
  sandboxEntry: RebuildSandboxEntry,
  messagingPlan: SandboxMessagingPlan | null,
  recreateOptions: Pick<
    RebuildRecreateOnboardOpts,
    "targetGatewayName" | "rebuildProviderReconfigure"
  >,
): string | null {
  const selection = target.resumeConfig;
  const needsBedrockRuntimeAdapter =
    selection.provider === "compatible-anthropic-endpoint" &&
    isBedrockRuntimeEndpoint(selection.endpointUrl);
  const rangeError = localInferenceRouteTimeoutError(
    selection.provider,
    needsBedrockRuntimeAdapter,
  );
  if (!rangeError) return null;

  const agentName = selection.agent || "openclaw";
  const nativeCustomSetup = usesCustomNativeOnboarding(
    selection.provider,
    selection.endpointUrl,
    sandboxEntry.name,
    sandboxEntry,
  );
  const selectsNativeLocal =
    usesNativeLocalInferenceForAgent(
      agentName,
      selection.provider,
      selection.endpointUrl,
      Boolean(selection.nimContainer),
    ) && !isPersistedPiSharedLocalInferenceRoute(sandboxEntry, selection);
  if (
    selection.nativeHostedProviderAttachment ||
    selection.nativeLocalProviderAttachment ||
    fixedNativeProvider(selection.provider) ||
    nativeCustomSetup ||
    selectsNativeLocal
  )
    return null;

  const preferredInferenceApi = resolveAgentProviderInferenceApi(
    agentName,
    target.agentDefinition,
    selection.provider,
    selection.preferredInferenceApi,
  );
  const forceInferenceSetup =
    recreateOptions.rebuildProviderReconfigure !== undefined ||
    preferredInferenceApi !== selection.preferredInferenceApi ||
    shouldRefreshCompatibleEndpointRouteForMessaging(
      selection.provider,
      [],
      messagingPlan,
      agentName,
      nativeCustomSetup,
    );
  return canResumeInferenceRoute({
    needsBedrockRuntimeAdapter,
    provider: selection.provider,
    // Only Portable Hermes injects host-local startup; its rebuild is denied at entry.
    hasHostLocalInference: false,
    // Authoritative rebuild resumes its validated, recorded provider selection.
    forceProviderSelection: false,
    forceInferenceSetup,
    effectiveResume: true,
    selectsNativeLocal: false,
    nativeLocalAttached: () => false,
    routeReady: () =>
      rebuildOnboardDependencies.isInferenceRouteReady(
        recreateOptions.targetGatewayName,
        selection.provider,
        selection.model,
      ),
  })
    ? null
    : rangeError;
}
