// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import type { SandboxMessagingPlan } from "../../messaging";
import { isSandboxBaseImageRefreshRequested } from "../../onboard/base-image-resolution-flow";
import { createRebuildProviderReconfigureHandoff } from "../../onboard/rebuild-route-handoff";
import { readSandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import * as registry from "../../state/registry";
import type { ToolDisclosure } from "../../tool-disclosure";
import { getSandboxTargetGatewayName } from "./gateway-target";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { PreparedRebuildImage } from "./rebuild-custom-image-preflight";
import { isDcodeRebuildAgent } from "./rebuild-dcode-orchestrator";
import { validatedRebuildRegistryUpdate } from "./rebuild-durable-config";
import {
  ensureRebuildAgentBaseImage,
  ensureRebuildTargetGatewaySelected,
  pinRebuildAgentBaseImageForRecreate,
  type RebuildAgentBaseImagePreflight,
  type RebuildSandboxEntry,
} from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { preflightRebuildMessagingConflicts } from "./rebuild-messaging-conflict-preflight";
import { stageRebuildMessagingPlanOrBail } from "./rebuild-messaging-phase";
import { checkRebuildGatewaySchemaPreflight } from "./rebuild-preflight-guards";
import { disposePreparedBuildContext } from "./rebuild-prepared-image-context";
import {
  hydrateMessagingConfigForRebuild,
  preflightAuthoritativeOnboardRuntime,
  preflightRebuildTargetRuntime,
  prepareRebuildRecreateOptions,
  prepareRebuildTargetConfig,
  type RebuildTargetConfig,
  stageRebuildHermesDashboardConfig,
} from "./rebuild-target-preflight";

export interface RebuildPreparedTarget {
  targetConfig: RebuildTargetConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  messagingPlan: SandboxMessagingPlan | null;
  baseImagePreflight: RebuildAgentBaseImagePreflight;
  preparedImage: PreparedRebuildImage | null;
}

/** Resolve, validate, and persist the complete non-destructive recreate target. */
export async function prepareRebuildTargetPreflights(args: {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  rebuildAgent: string | null;
  autoYes: boolean;
  requestedToolDisclosure?: ToolDisclosure;
  allowLegacyManagedImageRecovery?: boolean;
  preparedBackupRecovery?: boolean;
  log: RebuildLog;
  bail: RebuildBail;
}): Promise<RebuildPreparedTarget | null> {
  const {
    sandboxName,
    sandboxEntry,
    rebuildAgent,
    autoYes,
    requestedToolDisclosure,
    allowLegacyManagedImageRecovery,
    preparedBackupRecovery,
    log,
    bail,
  } = args;
  hydrateMessagingConfigForRebuild(sandboxName, log);
  if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sandboxEntry, log, bail)))
    return null;

  const targetConfig = prepareRebuildTargetConfig(
    sandboxName,
    sandboxEntry,
    rebuildAgent,
    log,
    bail,
    requestedToolDisclosure,
    allowLegacyManagedImageRecovery,
  );
  if (!targetConfig) return null;
  const { resumeConfig, durableConfig, credentialEnv, fromDockerfile } = targetConfig;
  const baseImageResolutionHint = readSandboxBaseImageResolutionMetadata(sandboxEntry.imageTag);
  const forceBaseImageRefresh = isSandboxBaseImageRefreshRequested(process.env);
  const recreateOptions = prepareRebuildRecreateOptions(
    sandboxName,
    sandboxEntry,
    rebuildAgent,
    fromDockerfile,
    resumeConfig.registryInferenceRoute,
    autoYes,
    baseImageResolutionHint,
    bail,
  );
  if (!recreateOptions) return null;
  // The durable resolver may recover a legacy row's choice from its matching
  // session. Use that authoritative value for both preflight and inner onboard,
  // never the raw registry fallback used while constructing generic options.
  recreateOptions.toolDisclosure = durableConfig.toolDisclosure;
  if (
    !stageRebuildHermesDashboardConfig(
      rebuildAgent,
      sandboxEntry,
      recreateOptions.controlUiPort,
      bail,
    )
  ) {
    return null;
  }

  const messagingPlan = await stageRebuildMessagingPlanOrBail(
    sandboxName,
    sandboxEntry,
    rebuildAgent,
    log,
    bail,
  );
  // Detect cross-sandbox credential conflicts immediately after staging the
  // exact rebuild plan, before host/runtime probes and every destructive phase.
  await preflightRebuildMessagingConflicts(messagingPlan, {
    sandboxName,
    gatewayName: getSandboxTargetGatewayName(sandboxName),
    registry,
    cliName: () => CLI_NAME,
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    bail,
  });
  if (
    !(await preflightAuthoritativeOnboardRuntime(
      sandboxName,
      resumeConfig,
      recreateOptions,
      bail,
      preparedBackupRecovery ? { deferInferenceRouteUntilOnboard: true } : {},
    ))
  ) {
    return null;
  }
  if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sandboxEntry, log, bail)))
    return null;
  if (!checkRebuildGatewaySchemaPreflight(sandboxName, sandboxEntry, bail)) return null;

  const rebuildsDcodeSandbox = isDcodeRebuildAgent(rebuildAgent);
  const baseImagePreflight = rebuildsDcodeSandbox
    ? { ok: true, imageRef: null, overrideEnvVar: null }
    : ensureRebuildAgentBaseImage(rebuildAgent, bail, {
        resolutionHint: baseImageResolutionHint,
        forceBaseImageRefresh,
      });
  if (!baseImagePreflight.ok) return null;
  const restoreBaseImageOverride = pinRebuildAgentBaseImageForRecreate(baseImagePreflight);
  let targetRuntimePreflight: Awaited<ReturnType<typeof preflightRebuildTargetRuntime>> = {
    ok: false,
  };
  try {
    targetRuntimePreflight = await preflightRebuildTargetRuntime(
      targetConfig,
      sandboxEntry,
      recreateOptions,
      log,
      bail,
      {
        allowMissingGatewayProviderWithHostCredential: preparedBackupRecovery,
        skipImagePreflight: rebuildsDcodeSandbox,
      },
    );
  } finally {
    restoreBaseImageOverride();
  }
  if (!targetRuntimePreflight.ok) return null;

  if (targetRuntimePreflight.requiresGatewayProviderReconfigure) {
    if (!resumeConfig.credentialEnv) {
      bail("Prepared provider reconfiguration is missing its credential binding");
      return null;
    }
    recreateOptions.rebuildProviderReconfigure = createRebuildProviderReconfigureHandoff({
      sandboxName,
      provider: resumeConfig.provider,
      model: resumeConfig.model,
      credentialEnv: resumeConfig.credentialEnv,
      endpointUrl: resumeConfig.endpointUrl,
    });
  }

  const preparedImage = targetRuntimePreflight.preparedImage;
  let retainPreparedImage = false;
  try {
    const validatedRegistryUpdate = validatedRebuildRegistryUpdate(
      resumeConfig,
      durableConfig,
      fromDockerfile,
      credentialEnv,
    );
    if (!registry.updateSandbox(sandboxName, validatedRegistryUpdate)) {
      bail("Sandbox registry entry disappeared during rebuild preflight");
      return null;
    }
    Object.assign(sandboxEntry, validatedRegistryUpdate);
    if (preparedImage) {
      recreateOptions.preparedImageRebuild = {
        buildContext: preparedImage,
        gatewayName: recreateOptions.targetGatewayName,
      };
    }

    retainPreparedImage = true;
    return {
      targetConfig,
      recreateOptions,
      messagingPlan,
      baseImagePreflight,
      preparedImage,
    };
  } finally {
    if (!retainPreparedImage && preparedImage) disposePreparedBuildContext(preparedImage);
  }
}
