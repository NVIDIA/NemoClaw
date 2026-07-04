// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import type { SandboxMessagingPlan } from "../../messaging";
import * as registry from "../../state/registry";
import { getSandboxTargetGatewayName } from "./gateway-target";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
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
}

/** Resolve, validate, and persist the complete non-destructive recreate target. */
export async function prepareRebuildTargetPreflights(args: {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  rebuildAgent: string | null;
  autoYes: boolean;
  log: RebuildLog;
  bail: RebuildBail;
}): Promise<RebuildPreparedTarget | null> {
  const { sandboxName, sandboxEntry, rebuildAgent, autoYes, log, bail } = args;
  hydrateMessagingConfigForRebuild(sandboxName, log);
  if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sandboxEntry, log, bail)))
    return null;

  const targetConfig = prepareRebuildTargetConfig(
    sandboxName,
    sandboxEntry,
    rebuildAgent,
    log,
    bail,
  );
  if (!targetConfig) return null;
  const { resumeConfig, durableConfig, credentialEnv, fromDockerfile } = targetConfig;
  const recreateOptions = prepareRebuildRecreateOptions(
    sandboxEntry,
    rebuildAgent,
    fromDockerfile,
    autoYes,
    bail,
  );
  if (!recreateOptions) return null;
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
    !(await preflightAuthoritativeOnboardRuntime(sandboxName, resumeConfig, recreateOptions, bail))
  ) {
    return null;
  }
  if (!(await ensureRebuildTargetGatewaySelected(sandboxName, sandboxEntry, log, bail)))
    return null;
  if (!checkRebuildGatewaySchemaPreflight(sandboxName, sandboxEntry, bail)) return null;

  const rebuildsDcodeSandbox = isDcodeRebuildAgent(rebuildAgent);
  const baseImagePreflight = rebuildsDcodeSandbox
    ? { ok: true, imageRef: null, overrideEnvVar: null }
    : ensureRebuildAgentBaseImage(rebuildAgent, bail);
  if (!baseImagePreflight.ok) return null;
  const restoreBaseImageOverride = pinRebuildAgentBaseImageForRecreate(baseImagePreflight);
  let targetRuntimeReady = false;
  try {
    targetRuntimeReady = await preflightRebuildTargetRuntime(
      targetConfig,
      sandboxEntry,
      recreateOptions,
      log,
      bail,
      { skipImagePreflight: rebuildsDcodeSandbox },
    );
  } finally {
    restoreBaseImageOverride();
  }
  if (!targetRuntimeReady) return null;

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

  return { targetConfig, recreateOptions, messagingPlan, baseImagePreflight };
}
