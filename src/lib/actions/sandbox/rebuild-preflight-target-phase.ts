// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { CLI_NAME } from "../../cli/branding";
import type { SandboxMessagingPlan } from "../../messaging";
import { isSandboxBaseImageRefreshRequested } from "../../onboard/base-image-resolution-flow";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import {
  createRebuildProviderReconfigureHandoff,
  mintProviderRecoveryReceipt,
  type ProviderRecoveryReceipt,
  type RegistryInferenceRoute,
} from "../../onboard/rebuild-route-handoff";
import { requireRuntimeProviderBundleForSandbox } from "../../onboard/runtime-provider/access";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../onboard/runtime-provider/current";
import {
  prepareManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff,
} from "../../onboard/workload/rebuild";
import { resolveSandboxWorkloadRuntimeCapabilities } from "../../onboard/workload/runtime";
import { readSandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import * as registry from "../../state/registry";
import type { ToolDisclosure } from "../../tool-disclosure";
import { prepareManagedRebuildProfileHandoff } from "./agents/managed-workload-rebuild-profile";
import {
  getPersistedSandboxTargetGatewayName,
  getSandboxTargetGatewayName,
} from "./gateway-target";
import type { RebuildBail, RebuildLog } from "./rebuild-credential-preflight";
import type { PreparedRebuildImage } from "./rebuild-custom-image-preflight";
import { isDcodeRebuildAgent } from "./rebuild-dcode-orchestrator";
import { validatedRebuildRegistryUpdate } from "./rebuild-durable-config";
import {
  disposeRebuildAgentBaseImagePreflight,
  ensureRebuildAgentBaseImage,
  ensureRebuildTargetGatewaySelected,
  pinRebuildAgentBaseImageForRecreate,
  replaceOpenShellRuntimeSelectionEnv,
  type RebuildAgentBaseImagePreflight,
  type RebuildSandboxEntry,
} from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import {
  getMcpPreparationRuntimeSelection,
  mcpRebuildRequiresRuntimeSelection,
} from "./rebuild-mcp-phase";
import { preflightRebuildMessagingConflicts } from "./rebuild-messaging-conflict-preflight";
import { stageRebuildMessagingPlanOrBail } from "./rebuild-messaging-phase";
import {
  checkRebuildGatewaySchemaPreflight,
  commitRebuildRoutePreflight,
  type RebuildRoutePreflightReceipt,
} from "./rebuild-preflight-guards";
import { disposePreparedBuildContext } from "./rebuild-prepared-image-context";
import {
  hydrateMessagingConfigForRebuild,
  preflightAuthoritativeOnboardRuntime,
  preflightRebuildTargetRuntime,
  prepareRebuildRecreateOptions,
  prepareRebuildTargetConfig,
  type RebuildTargetConfig,
  stageRebuildHermesDashboardConfig,
  stageRecordedDeferredN1xIntent,
} from "./rebuild-target-preflight";

/** Upper bound on how long a minted provider-recovery receipt stays valid. */
const PROVIDER_RECOVERY_RECEIPT_TTL_MS = 60 * 60 * 1000;

/** Stage recovery authority only from a route captured from the registry. */
export function stageRegistryProviderRecoveryReceipt(
  recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt },
  target: {
    sandboxName: string;
    gatewayName: string;
    provider: string;
    model: string;
  },
  registryRoute: RegistryInferenceRoute | null,
  minting?: { nonce: string; expiresAtMs: number },
): void {
  if (!registryRoute) return;
  recreateOptions.providerRecoveryReceipt = mintProviderRecoveryReceipt(
    { ...target, route: registryRoute },
    minting ?? {
      nonce: randomUUID(),
      expiresAtMs: Date.now() + PROVIDER_RECOVERY_RECEIPT_TTL_MS,
    },
  );
}

export interface RebuildPreparedTarget {
  targetConfig: RebuildTargetConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  messagingPlan: SandboxMessagingPlan | null;
  baseImagePreflight: RebuildAgentBaseImagePreflight;
  preparedImage: PreparedRebuildImage | null;
  routePreflightReceipt: RebuildRoutePreflightReceipt;
}

/** Freeze the MCP-bearing rebuild on the recorded OpenShell target before live probes. */
export function resolveRebuildMcpRuntimeSelection(
  sandboxEntry: RebuildSandboxEntry,
  bail: RebuildBail,
): OpenShellRuntimeSelection | undefined {
  if (!mcpRebuildRequiresRuntimeSelection(sandboxEntry)) return undefined;
  try {
    return getMcpPreparationRuntimeSelection(sandboxEntry);
  } catch (error) {
    return bail(
      `Could not bind MCP rebuild preflight to the recorded OpenShell target: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Pin read-only rebuild probes without selecting, starting, or repairing a gateway. */
export function pinRebuildTargetGatewayForReadiness(
  sandboxName: string,
  sandboxEntry: RebuildSandboxEntry,
  log: RebuildLog,
  runtimeSelection?: OpenShellRuntimeSelection,
): string {
  const gatewayName = getPersistedSandboxTargetGatewayName(sandboxEntry);
  if (runtimeSelection && runtimeSelection.gatewayName !== gatewayName) {
    throw new Error(
      `OpenShell runtime selection '${runtimeSelection.gatewayName}' does not match recorded gateway '${gatewayName}'.`,
    );
  }
  if (runtimeSelection) replaceOpenShellRuntimeSelectionEnv(process.env, runtimeSelection);
  else process.env.OPENSHELL_GATEWAY = gatewayName;
  log(`Pinned rebuild readiness probes for '${sandboxName}' to target gateway '${gatewayName}'`);
  return gatewayName;
}

/** Keep gateway selection and recovery behind authoritative readiness. */
export async function runRebuildGatewayRecoveryAfterReadiness(options: {
  assertReadiness(): Promise<boolean>;
  afterReadiness(): void;
  recoverGateway(): Promise<boolean>;
}): Promise<boolean> {
  if (!(await options.assertReadiness())) return false;
  options.afterReadiness();
  return options.recoverGateway();
}

/** Carry the outer resolver's verified provenance into the inner onboard build. */
export function stageRebuildBaseImageResolutionHandoff(
  recreateOptions: Pick<RebuildRecreateOnboardOpts, "preResolvedBaseImageMetadata">,
  preflight: RebuildAgentBaseImagePreflight,
): void {
  const metadata = preflight.resolutionMetadata;
  if (!metadata) return;
  const imageId = metadata.imageId.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  const localHandoffPattern = imageId
    ? new RegExp(
        `^nemoclaw-[a-z0-9][a-z0-9._-]*-sandbox-base-local:(?:image-|rebuild-[1-9][0-9]*-[0-9a-f]{16}-image-)${imageId}$`,
        "i",
      )
    : null;
  const imageRef = preflight.imageRef ?? "";
  const remoteDigest = metadata.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  const immutableRemoteHandoff =
    remoteDigest !== undefined &&
    metadata.source !== "local" &&
    metadata.ref === imageRef &&
    imageRef.toLowerCase() === `${metadata.imageName}@sha256:${remoteDigest}`.toLowerCase();
  if (!localHandoffPattern?.test(imageRef) && !immutableRemoteHandoff) {
    throw new Error("Rebuild base-image provenance did not match its immutable handoff");
  }
  recreateOptions.preResolvedBaseImageMetadata = metadata;
}

/** Resolve, validate, and persist the complete non-destructive recreate target. */
export async function prepareRebuildTargetPreflights(args: {
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  rebuildAgent: string | null;
  autoYes: boolean;
  requestedToolDisclosure?: ToolDisclosure;
  requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode;
  requestedObservabilityEnabled?: boolean;
  allowLegacyManagedImageRecovery?: boolean;
  preparedBackupRecovery?: boolean;
  mcpRuntimeSelection?: OpenShellRuntimeSelection;
  log: RebuildLog;
  bail: RebuildBail;
}): Promise<RebuildPreparedTarget | null> {
  const {
    sandboxName,
    sandboxEntry,
    rebuildAgent,
    autoYes,
    requestedToolDisclosure,
    requestedDcodeAutoApprovalMode,
    requestedObservabilityEnabled,
    allowLegacyManagedImageRecovery,
    preparedBackupRecovery,
    mcpRuntimeSelection: frozenMcpRuntimeSelection,
    log,
    bail,
  } = args;
  const mcpRuntimeSelection =
    frozenMcpRuntimeSelection ?? resolveRebuildMcpRuntimeSelection(sandboxEntry, bail);
  hydrateMessagingConfigForRebuild(sandboxName, log);
  pinRebuildTargetGatewayForReadiness(sandboxName, sandboxEntry, log, mcpRuntimeSelection);

  const targetConfig = prepareRebuildTargetConfig(
    sandboxName,
    sandboxEntry,
    rebuildAgent,
    log,
    bail,
    requestedToolDisclosure,
    allowLegacyManagedImageRecovery,
    requestedDcodeAutoApprovalMode,
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
  if (mcpRuntimeSelection) recreateOptions.runtimeSelection = mcpRuntimeSelection;
  let managedWorkloadRebuildCatalog: Awaited<
    ReturnType<typeof prepareManagedWorkloadRebuildHandoff>
  > = null;
  try {
    const runtimeProvider = requireRuntimeProviderBundleForSandbox(
      sandboxEntry,
      CURRENT_RUNTIME_PROVIDER_BUNDLES,
    );
    const runtime = resolveSandboxWorkloadRuntimeCapabilities({
      driverName: runtimeProvider.identity.id,
    });
    managedWorkloadRebuildCatalog = await prepareManagedWorkloadRebuildHandoff(sandboxEntry, {
      runtime,
      provider: runtimeProvider,
    });
    if (managedWorkloadRebuildCatalog) {
      prepareSandboxWorkloadSourceFromRebuildHandoff(
        managedWorkloadRebuildCatalog,
        runtime,
        runtimeProvider,
      );
    }
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
    return null;
  }
  // The durable resolver may recover a legacy row's choice from its matching
  // session. Use that authoritative value for both preflight and inner onboard,
  // never the raw registry fallback used while constructing generic options.
  recreateOptions.toolDisclosure = durableConfig.toolDisclosure;
  recreateOptions.dcodeAutoApprovalMode = durableConfig.dcodeAutoApprovalMode;
  recreateOptions.dcodeAutoApprovalRequestedExplicitly =
    requestedDcodeAutoApprovalMode !== undefined;
  recreateOptions.observabilityEnabled =
    requestedObservabilityEnabled ?? recreateOptions.observabilityEnabled;
  recreateOptions.observabilityRequestedExplicitly = requestedObservabilityEnabled !== undefined;
  stageRecordedDeferredN1xIntent(recreateOptions, sandboxEntry, resumeConfig);
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
  if (managedWorkloadRebuildCatalog) {
    try {
      recreateOptions.managedWorkloadRebuild = prepareManagedRebuildProfileHandoff({
        catalogHandoff: managedWorkloadRebuildCatalog,
        targetConfig,
        recreateOptions,
        messagingPlan,
      });
    } catch (error) {
      bail(error instanceof Error ? error.message : String(error));
      return null;
    }
  }
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
  const gatewayRecovered = await runRebuildGatewayRecoveryAfterReadiness({
    assertReadiness: () =>
      preflightAuthoritativeOnboardRuntime(
        sandboxName,
        resumeConfig,
        recreateOptions,
        bail,
        preparedBackupRecovery ? { deferInferenceRouteUntilOnboard: true } : {},
      ),
    afterReadiness: () =>
      stageRegistryProviderRecoveryReceipt(
        recreateOptions,
        {
          sandboxName,
          gatewayName: recreateOptions.targetGatewayName,
          provider: resumeConfig.provider,
          model: resumeConfig.model,
        },
        resumeConfig.registryInferenceRoute,
      ),
    recoverGateway: () =>
      ensureRebuildTargetGatewaySelected(sandboxName, sandboxEntry, log, bail, mcpRuntimeSelection),
  });
  if (!gatewayRecovered) return null;
  if (!checkRebuildGatewaySchemaPreflight(sandboxName, sandboxEntry, bail, mcpRuntimeSelection)) {
    return null;
  }

  const rebuildsDcodeSandbox = isDcodeRebuildAgent(rebuildAgent);
  const rebuildsManagedWorkload = recreateOptions.managedWorkloadRebuild !== undefined;
  const baseImagePreflight =
    rebuildsDcodeSandbox || rebuildsManagedWorkload
      ? { ok: true, imageRef: null, overrideEnvVar: null }
      : ensureRebuildAgentBaseImage(rebuildAgent, bail, {
          resolutionHint: baseImageResolutionHint,
          forceBaseImageRefresh,
        });
  if (!baseImagePreflight.ok) return null;
  let retainBaseImagePreflight = false;
  try {
    stageRebuildBaseImageResolutionHandoff(recreateOptions, baseImagePreflight);
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
          skipImagePreflight: rebuildsDcodeSandbox || rebuildsManagedWorkload,
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
      const routePreflight = commitRebuildRoutePreflight({
        sandboxName,
        gatewayName: recreateOptions.targetGatewayName,
        targetUpdate: validatedRegistryUpdate,
      });
      if (!routePreflight.ok) {
        bail(routePreflight.message);
        return null;
      }
      Object.assign(sandboxEntry, validatedRegistryUpdate);
      if (routePreflight.receipt.migratedSandboxNames.length > 0) {
        console.log(
          `Migrated legacy shared-gateway credential metadata for: ${routePreflight.receipt.migratedSandboxNames.join(", ")}`,
        );
      }
      if (preparedImage) {
        recreateOptions.preparedImageRebuild = {
          buildContext: preparedImage,
          gatewayName: recreateOptions.targetGatewayName,
        };
      }

      retainPreparedImage = true;
      retainBaseImagePreflight = true;
      return {
        targetConfig,
        recreateOptions,
        messagingPlan,
        baseImagePreflight,
        preparedImage,
        routePreflightReceipt: routePreflight.receipt,
      };
    } finally {
      if (!retainPreparedImage && preparedImage) disposePreparedBuildContext(preparedImage);
    }
  } finally {
    if (!retainBaseImagePreflight) {
      try {
        if (!disposeRebuildAgentBaseImagePreflight(baseImagePreflight)) {
          console.warn("  Warning: temporary rebuild base-image handoff could not be removed.");
        }
      } catch {
        // Best effort; preserve the original preflight result or error.
      }
    }
  }
}
