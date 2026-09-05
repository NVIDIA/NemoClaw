// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  recreateOptions: Pick<RebuildRecreateOnboardOpts, "allowDeferredN1xManagedVllm">,
  sandboxEntry: Pick<
    RebuildSandboxEntry,
    | "provider"
    | "model"
    | "endpointUrl"
    | "endpointSource"
    | "openshellDriver"
    | "hostLocalInferenceReceipt"
    | "nimContainer"
  >,
  rebuildSelection: {
    provider: string;
    model: string;
    pinEndpoint: boolean;
    endpointUrl: string | null;
  },
): void {
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
    );
  if (recordedStandardProviderIsEligible || recordedManagedVllmIsEligible) {
    recreateOptions.allowDeferredN1xManagedVllm = true;
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
