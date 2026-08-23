// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxCreateOrchestrationRuntime } from "../../onboard";
import { HERMES_PORTABLE_OPENSHELL_VERSION } from "../../adapters/openshell/resolve-shared";
import type { AgentDefinition } from "../../agent/defs";
import type { WebSearchConfig } from "../../inference/web-search";
import type { BackupResult } from "../../state/sandbox";
import type { SandboxEntry } from "../../state/registry";
import type { HermesAuthMethod } from "../hermes-auth";
import type { PreparedSandboxBuildContext } from "../build-context-stage";
import type { DcodeSelectionDriftReader } from "../dcode-selection-drift";
import type { OwnedSandboxRecreateRuntime } from "../onboard-recreate-journal";
import type { SandboxGpuConfig } from "../sandbox-gpu-mode";
import type { PortableOnboardRuntimeContext } from "../session-bootstrap";
import type { InferenceRouteReservationAuthority, SandboxCreateIntent } from "../types";
import * as sandboxCreatePlanMaterialization from "../sandbox-create-plan-materialization";
import {
  publishAttachedProvidersBeforeDockerSandboxCreation,
  validateAttachedMessagingProvidersBeforeSandboxCreation,
} from "./provider-publication";

type SandboxRecreateReasonInput = {
  sandboxName: string;
  recreateForAgentDrift: boolean;
  existingAgentName: string | null | undefined;
  requestedAgentName: string | null | undefined;
  needsProviderMigration: boolean;
  actionableSelectionDrift: boolean;
  sandboxGpuDrift: boolean;
  hermesToolGatewayDrift: boolean;
  hermesDashboardDrift: boolean;
  observabilityDrift: boolean;
  dcodeAutoApprovalDrift: boolean;
  toolDisclosureMigrationNote: string | null | undefined;
  credentialRotationChanged: boolean;
  existingSandboxState: string;
};

export function readManagedDcodeCreateSelectionDrift(
  input: {
    sandboxName: string;
    provider: string;
    model: string;
    preferredInferenceApi: string | null;
    createIntent: Pick<SandboxCreateIntent, "endpointUrl"> | null;
  },
  readDcodeSelectionDrift: DcodeSelectionDriftReader,
) {
  return readDcodeSelectionDrift(
    input.sandboxName,
    input.provider,
    input.model,
    input.preferredInferenceApi,
    input.createIntent?.endpointUrl ?? null,
  );
}

function reportSandboxRecreateReason(
  input: SandboxRecreateReasonInput,
  deps: {
    formatSandboxAgentName(agentName: string | null | undefined): string;
    note(message: string): void;
  },
): void {
  const { sandboxName } = input;
  if (input.recreateForAgentDrift) {
    deps.note(
      `  Sandbox '${sandboxName}' exists as ${deps.formatSandboxAgentName(input.existingAgentName)} — recreating as ${deps.formatSandboxAgentName(input.requestedAgentName)}.`,
    );
  } else if (input.needsProviderMigration) {
    console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
    console.log("  Recreating to ensure credentials flow through the provider pipeline.");
  } else if (input.actionableSelectionDrift) {
    deps.note(
      `  Sandbox '${sandboxName}' exists — recreating because its live model/provider selection is stale or unreadable.`,
    );
  } else if (input.sandboxGpuDrift) {
    deps.note(`  Sandbox '${sandboxName}' exists — recreating to apply sandbox GPU settings.`);
  } else if (input.hermesToolGatewayDrift) {
    deps.note(
      `  Sandbox '${sandboxName}' exists — recreating to apply Hermes managed-tool changes.`,
    );
  } else if (input.hermesDashboardDrift) {
    deps.note(`  Sandbox '${sandboxName}' exists — recreating to apply Hermes dashboard settings.`);
  } else if (input.observabilityDrift) {
    deps.note(`  Sandbox '${sandboxName}' exists — recreating to apply observability settings.`);
  } else if (input.dcodeAutoApprovalDrift) {
    deps.note(
      `  Sandbox '${sandboxName}' exists — recreating to apply DCode auto-approval settings.`,
    );
  } else if (input.toolDisclosureMigrationNote) {
    deps.note(input.toolDisclosureMigrationNote);
  } else if (input.credentialRotationChanged) {
    // Message already printed above during backup.
  } else if (input.existingSandboxState === "ready") {
    deps.note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
  } else {
    deps.note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
  }
}

export async function completeHermesPortableSandboxRegistration(input: {
  readonly sandboxName: string;
  readonly completeRegistration: () => Promise<unknown>;
  readonly readRegistry: (sandboxName: string) => SandboxEntry | null;
}): Promise<SandboxEntry> {
  await input.completeRegistration();
  const registered = input.readRegistry(input.sandboxName);
  if (!registered) {
    throw new Error("Hermes portable sandbox registration returned no authority.");
  }
  return registered;
}

export function hasManagedMcpRebuildHandoff(
  createIntent: SandboxCreateIntent | null | undefined,
): boolean {
  const handoff = createIntent?.recreateJournalTargetIntentFingerprint;
  return Boolean(
    handoff && createIntent?.recreateTransaction?.targetIntentFingerprint === handoff,
  );
}

function shouldRefuseManagedMcpRecreate(
  preservedMcpState: unknown,
  managedMcpRebuildHandoff: boolean,
): boolean {
  return Boolean(preservedMcpState) && !managedMcpRebuildHandoff;
}

function hasPreservedManagedMcpRebuildHandoff(
  preservedMcpState: unknown,
  createIntent: SandboxCreateIntent | null | undefined,
): boolean {
  return Boolean(preservedMcpState) && hasManagedMcpRebuildHandoff(createIntent);
}

type ApplyRecreatePolicyCarryForward = (
  sandboxName: string,
  nonInteractive: boolean,
  note: (message: string) => void,
  rebuildPolicyPresets?: readonly string[],
) => void;

/** Reseed an outer rebuild after its owned delete leaves no live source branch. */
export function applyAbsentSandboxRebuildPolicyCarryForward(
  input: {
    readonly sandboxName: string;
    readonly liveExists: boolean;
    readonly nonInteractive: boolean;
    readonly note: (message: string) => void;
    readonly rebuildPolicyPresets?: readonly string[];
  },
  applyRecreatePolicyCarryForward: ApplyRecreatePolicyCarryForward,
): void {
  if (input.liveExists || !Array.isArray(input.rebuildPolicyPresets)) return;
  applyRecreatePolicyCarryForward(
    input.sandboxName,
    input.nonInteractive,
    input.note,
    input.rebuildPolicyPresets,
  );
}

export function proveRecreateSourceBeforePolicyCarryForward<T>(input: {
  readonly createRecreateRuntime: () => T;
  readonly carryForward: () => void;
}): T {
  const runtime = input.createRecreateRuntime();
  input.carryForward();
  return runtime;
}

export function createSandboxWithBaseImageResolution(runtime: SandboxCreateOrchestrationRuntime) {
  return async function createSandboxWithBaseImageResolution(
    baseImageResolutionContext: import("../base-image-resolution-flow").BaseImageResolutionContext,
    portableRuntimeContext: PortableOnboardRuntimeContext | null,
    computePlan: import("../compute/plan").OpenShellComputePlan,
    managedWorkloadRebuild: import("../workload/rebuild").ManagedWorkloadRebuildHandoff | null,
    tempManagedRuntime: boolean,
    tempManagedRuntimeCatalog: string | null,
    dashboardPortReservationScope: import("../dashboard-port").DashboardPortReservationScope,
    hermesApiPortReservationScope: import("../../agent/onboard").HermesApiPortReservationScope,
    gpu: ReturnType<typeof import("../../inference/nim").detectGpu>,
    model: string,
    provider: string,
    preferredInferenceApi: string | null = null,
    sandboxNameOverride: string | null = null,
    webSearchConfig: WebSearchConfig | null = null,
    enabledChannels: string[] | null = null,
    fromDockerfile: string | null = null,
    agent: AgentDefinition | null = null,
    controlUiPort: number | null = null,
    sandboxGpuConfig: SandboxGpuConfig | null = null,
    resourceProfile: import("../../resources-cmd").ResourceProfile | null = null,
    hermesToolGateways: string[] = [],
    hermesAuthMethod: HermesAuthMethod | null = null,
    inferenceRouteReservationAuthority: InferenceRouteReservationAuthority | null = null,
    createIntent: import("../types").SandboxCreateIntent | null = null,
    preparedBuildContext: PreparedSandboxBuildContext | null = null,
  ) {
    const portableRuntimeAuthority = portableRuntimeContext?.authority ?? null;
    const {
      DASHBOARD_PORT,
      GATEWAY_NAME,
      GATEWAY_PORT,
      ROOT,
      SCRIPTS,
      agentDefs,
      agentOnboard,
      applyExtraProviderReconciliation,
      assessHost,
      baseImageResolutionFlow,
      cliDisplayName,
      cliName,
      completeOrdinaryOnboardSandboxCreation,
      confirmRecreateForSelectionDrift,
      createOnboardCreatedSandboxCompletion,
      createOnboardCreatedSandboxRegistration,
      createSandboxRecreateProtection,
      dashboardRuntime,
      dcodeAutoApprovalFlow,
      detectMessagingCredentialRotation,
      ensureAgentFixedForward,
      ensureDashboardForward,
      filterEnabledChannelsByAgent,
      formatSandboxAgentName,
      formatSandboxBuildEstimateNote,
      getDashboardForwardPort,
      readDcodeSelectionDrift,
      getDefaultSandboxNameForAgent,
      getDockerDriverGatewayStateDir,
      getHermesToolGatewayBroker,
      getRequestedSandboxAgentName,
      getSandboxAgentDrift,
      getSandboxRecreateObservation,
      getSandboxReuseState,
      getSandboxRuntimeRegistryFields,
      getSelectionDrift,
      hasSandboxGpuDrift,
      inferenceConfig,
      inspectSandboxForCreate,
      isLinuxDockerDriverGatewayEnabled,
      isNonInteractive,
      isRecreateSandbox,
      isWsl,
      managedWorkloadOnboard,
      messagingChannelSetup,
      nim,
      normalizeHermesAuthMethod,
      normalizeHermesToolGatewaySelections,
      note,
      observabilityCommandFlag,
      observabilityPolicy,
      onboardHermesDashboard,
      onboardSession,
      onboardSessionBootstrap,
      openshellArgv,
      path,
      planRegisteredExtraProviders,
      policyPresetCarry,
      preparedDcodeRebuild,
      promptValidatedSandboxName,
      promptYesNoOrDefault,
      providerExistsInGateway,
      recreateJournal,
      registry,
      requiresSelectionRecreate,
      reserveCreateSandboxDashboardPort,
      resolveSandboxGpuConfig,
      runCaptureOpenshell,
      runOpenshell,
      runSandboxProviderPreDeleteCleanup,
      sandboxAgent,
      sandboxBuildPatchConfig,
      sandboxCancelRollback,
      sandboxCreateIntentResolver,
      sandboxGpuCreateFlow,
      sandboxLifecycle,
      sandboxMutationLock,
      sandboxRecreateTransaction,
      sandboxRegistration,
      sandboxRegistryMetadata,
      sandboxReuse,
      shouldSkipPreRecreateBackup,
      sleepSeconds,
      step,
      stringSetsEqual,
      toolDisclosureFlow,
      upsertMessagingProviders,
      usesManagedDcodeIdentity,
      validateName,
      verifyDirectSandboxGpu,
      waitForSandboxRecreateDeleteAbsence,
      wasSandboxDefault,
      updateReusedSandboxMetadata,
      getSandboxInferenceConfig,
      redact,
      openshellShellCommand,
      discloseInitialSandboxPolicy,
      compactText,
      runFile,
      dockerInfoFormat,
      runCapture,
    } = runtime;

    step(6, 8, "Creating sandbox");
    const sandboxName = validateName(
      sandboxNameOverride ?? (await promptValidatedSandboxName(agent)),
      "sandbox name",
    );
    preparedDcodeRebuild.assertPreparedDcodeTarget(preparedBuildContext, agent, fromDockerfile);
    const effectiveAgent = sandboxAgent.getEffectiveSandboxAgent(agent);
    const requestedAgentName = getRequestedSandboxAgentName(effectiveAgent);
    const legacyDockerfilePath =
      effectiveAgent.dockerfilePath ??
      effectiveAgent.legacyPaths?.dockerfile ??
      path.join(ROOT, "Dockerfile");
    enabledChannels = filterEnabledChannelsByAgent(enabledChannels, agent);
    const effectiveSandboxGpuConfig =
      sandboxGpuConfig ?? resolveSandboxGpuConfig(gpu, { flag: null, device: null });
    const agentCreateInput = sandboxGpuCreateFlow.resolveAgentCreateInput(
      agent,
      isLinuxDockerDriverGatewayEnabled(),
    );
    const preparedCreateIntent = await sandboxCreateIntentResolver.resolvePortableLifecycle(
      {
        sandboxName,
        inferenceProvider: provider,
        enabledChannels,
        webSearchConfig,
        agent,
        sandboxGpuConfig: effectiveSandboxGpuConfig,
        resourceProfile,
        hermesToolGateways,
        baselineExclusions: sandboxRegistration.baselineExclusionsForCreate(sandboxName),
        ...(createIntent?.reuseRegisteredCredentials ? { reuseRegisteredCredentials: true } : {}),
        ...(createIntent?.policyTier !== undefined ? { policyTier: createIntent.policyTier } : {}),
      },
      {
        hermesPortable: agentCreateInput.hermesPortableLifecycle,
        requestedExtraProviders: createIntent?.extraProviders,
        resolvedIntent: createIntent?.resolved,
        planOrdinaryExtraProviders: () =>
          planRegisteredExtraProviders(GATEWAY_NAME, { runOpenshell }),
      },
    );
    const resolvedCreateIntent = preparedCreateIntent.intent;
    const messagingCapabilities = preparedCreateIntent.messagingCapabilities;
    const manageDashboard = sandboxGpuCreateFlow.shouldManageHermesPortableDashboard(
      dashboardRuntime.shouldManageDashboardForAgent(agent),
      agent,
    );
    const isManagedDcodeAgent = usesManagedDcodeIdentity(agent?.name, fromDockerfile);
    let effectivePort = 0,
      chatUiUrl = "",
      hermesApiPortReservationInput = {
        agentName: agent?.name,
        sandboxName,
        env: process.env,
        getSandbox: registry.getSandbox,
        captureForwardList: () => runCaptureOpenshell(["forward", "list"], { ignoreError: true }),
        warn: (message: string) => console.warn(message),
      };
    if (manageDashboard) {
      const dashboardSelection = await reserveCreateSandboxDashboardPort({
        sandboxName,
        controlUiPort,
        chatUiUrlEnv: process.env.CHAT_UI_URL,
        persistedPort: registry.getSandbox(sandboxName)?.dashboardPort ?? null,
        agentForwardPort: dashboardRuntime.getAgentPrimaryForwardPort(agent, DASHBOARD_PORT),
        defaultPort: DASHBOARD_PORT,
        forwardListOutput: runCaptureOpenshell(["forward", "list"], { ignoreError: true }),
        warn: (message: string) => console.warn(message),
      });
      ({ effectivePort, chatUiUrl } = dashboardSelection);
      dashboardPortReservationScope.current = dashboardSelection.reservation;
    }
    const hermesDashboardForwarding = onboardHermesDashboard.createHermesDashboardOnboardForwarding(
      {
        agentName: agent?.name,
        env: process.env,
        ensureForward: ensureAgentFixedForward,
        note,
        runOpenshell,
        getApiForwardPort: () => getDashboardForwardPort(chatUiUrl),
      },
    );
    const hermesDashboardState = hermesDashboardForwarding.resolveStateForPort(effectivePort);
    const { messagingTokenDefs, hasMessagingTokens } = messagingCapabilities;

    const {
      existingEntry,
      preservedMcpState,
      liveExists,
      effectiveToolDisclosure,
      toolDisclosureMigrationNeeded,
      toolDisclosureMigrationNote,
    } = agentCreateInput.hermesPortableLifecycle
      ? toolDisclosureFlow.prepareHermesPortableToolDisclosure(createIntent?.toolDisclosure ?? null)
      : toolDisclosureFlow.prepareSandboxToolDisclosure(
          sandboxName,
          preparedBuildContext?.rebuildTarget?.fromDockerfile
            ? preparedBuildContext.stagedDockerfile
            : fromDockerfile,
          isRecreateSandbox(createIntent?.recreate),
          inspectSandboxForCreate,
          createIntent?.toolDisclosure ?? null,
        );
    // Prove the preserved source row before replacing its stale preset list.
    // Policy carry-forward is an owned post-delete mutation, but applying it
    // before recreate recovery makes the journal correctly reject that row as
    // changed before the replacement can be created.
    let recreateRuntime:
      | import("../sandbox-recreate-transaction").SandboxRecreateRuntime
      | OwnedSandboxRecreateRuntime = proveRecreateSourceBeforePolicyCarryForward({
      createRecreateRuntime: () =>
        sandboxRecreateTransaction.createSandboxRecreateRuntime(
          onboardSession,
          createIntent?.recreateTransaction,
          sandboxName,
          GATEWAY_NAME,
          existingEntry,
          getSandboxRecreateObservation,
          note,
        ),
      carryForward: () =>
        applyAbsentSandboxRebuildPolicyCarryForward(
          {
            sandboxName,
            liveExists,
            nonInteractive: isNonInteractive(),
            note,
            rebuildPolicyPresets: createIntent?.rebuildPolicyPresets,
          },
          policyPresetCarry.applyRecreatePolicyCarryForward,
        ),
    });
    const restoreReusedSandboxDashboard = async (selectionVerified: boolean): Promise<void> => {
      await dashboardPortReservationScope.release();
      ({ chatUiUrl } = sandboxReuse.applyReusedSandboxDashboardState({
        sandboxName,
        chatUiUrl,
        env: process.env,
        agent,
        model,
        provider,
        selectionVerified,
        sandboxGpuConfig: effectiveSandboxGpuConfig,
        gatewayName: GATEWAY_NAME,
        gatewayPort: GATEWAY_PORT,
        manageDashboard,
        ensureDashboardForward,
        hermesDashboardForwarding,
        updateReusedSandboxMetadata,
      }));
    };
    if (recreateRuntime.acceptedTarget) {
      await restoreReusedSandboxDashboard(true);
      return sandboxName;
    }
    const observabilityDrift = observabilityPolicy.hasRegisteredDcodeObservabilityDrift(
      liveExists,
      isManagedDcodeAgent,
      existingEntry,
      createIntent?.observabilityEnabled,
    );
    const dcodeAutoApprovalPlan = dcodeAutoApprovalFlow.prepareDcodeAutoApprovalCreatePlan(
      {
        sandboxName,
        liveExists,
        managedDcodeAgent: isManagedDcodeAgent,
        registryEntry: existingEntry,
        requestedMode: createIntent?.dcodeAutoApprovalMode,
      },
      { error: console.error, exitProcess: (code) => process.exit(code) },
    );
    const envMessagingState =
      messagingChannelSetup.MessagingHostStateApplier.readPlanStateFromEnv();
    const plannedMessagingState =
      envMessagingState?.plan.sandboxName === sandboxName ? envMessagingState : undefined;
    const managedWorkloadRuntime = managedWorkloadOnboard.createManagedWorkloadOnboardRuntime(
      {
        computePlan,
        managedWorkloadRebuild,
        tempManagedRuntime:
          tempManagedRuntime ||
          managedWorkloadOnboard.shouldActivateStockManagedRuntime({
            portableLifecycle: sandboxGpuCreateFlow.resolvePortableLifecycleMode(agent),
            hermesPortableLifecycle: agentCreateInput.hermesPortableLifecycle,
            agentName: requestedAgentName,
          }),
        tempManagedRuntimeCatalog,
        agentName: requestedAgentName,
        legacyDockerfilePath,
        customDockerfilePath:
          fromDockerfile ?? (preparedBuildContext ? preparedBuildContext.stagedDockerfile : null),
        rootDir: ROOT,
        model,
        provider,
        preferredInferenceApi,
        endpointUrl: createIntent?.endpointUrl ?? null,
        startupProfile: {
          chatUiUrl,
          effectiveDashboardPort: effectivePort,
          manageDashboard,
          dashboardBindAddress: process.env.NEMOCLAW_DASHBOARD_BIND,
          wslExposure: requestedAgentName === "openclaw" && isWsl(),
          hermesDashboardState,
          webSearch: webSearchConfig,
          toolDisclosure: effectiveToolDisclosure,
          hermesToolGateways,
          messagingPlan: plannedMessagingState?.plan ?? null,
          dcodeAutoApprovalMode: dcodeAutoApprovalPlan.mode,
          observabilityEnabled: createIntent?.observabilityEnabled === true,
          environment: process.env,
        },
        note,
        fallbackBuildEstimate: () =>
          process.env.NEMOCLAW_IGNORE_RUNTIME_RESOURCES === "1"
            ? null
            : formatSandboxBuildEstimateNote(assessHost()),
      },
      {
        resolveAgentInferenceApi: inferenceConfig.resolveAgentInferenceApi,
        getSandboxInferenceConfig,
      },
    );
    const ensurePreparedSandboxWorkload = () =>
      agentCreateInput.hermesPortableLifecycle
        ? managedWorkloadOnboard.prepareHermesPortableSandboxWorkloadForLifecycle(
            managedWorkloadRuntime,
            legacyDockerfilePath,
          )
        : managedWorkloadOnboard.prepareSandboxWorkloadForPortableLifecycle(
            managedWorkloadRuntime,
            sandboxGpuCreateFlow.resolvePortableLifecycleMode(agent),
          );
    const prepareHermesStateVolumeLifecycle = (
      workload: Awaited<ReturnType<typeof ensurePreparedSandboxWorkload>>,
    ) =>
      managedWorkloadOnboard.createManagedHermesStateVolumeOnboardLifecycle({
        agentName: requestedAgentName,
        runtimeProvider: managedWorkloadRuntime.runtimeProvider,
        sandboxName,
        workloadKind: workload.source.kind,
      });
    // #4614: capture default AFTER prune so a stale registry row isn't read as a live sandbox.
    const sandboxWasLiveDefault =
      liveExists && wasSandboxDefault(registry.getDefault(), sandboxName);

    let pendingStateRestore: BackupResult | null = null;
    let notReadyRecreateInProgress = false;
    const customOpenClawImage =
      Boolean(fromDockerfile) && getRequestedSandboxAgentName(agent) === "openclaw";
    const recreateProtection = createSandboxRecreateProtection({
      sandboxName,
      sandboxEntry: existingEntry,
      customOpenClawImage,
      note,
    });
    const openRecreateJournal = (): OwnedSandboxRecreateRuntime =>
      recreateJournal.openOnboardRecreateJournal({
        target: { sandboxName, gatewayName: GATEWAY_NAME, gatewayPort: GATEWAY_PORT },
        agentName: getRequestedSandboxAgentName(agent) || "openclaw",
        note,
        observe: (probeTarget) =>
          getSandboxRecreateObservation(probeTarget.sandboxName, probeTarget.gatewayName),
        intent: {
          agent: getRequestedSandboxAgentName(agent) || null,
          fromDockerfile: fromDockerfile ?? null,
          provider: provider ?? null,
          model: model ?? null,
          preferredInferenceApi: preferredInferenceApi ?? null,
          sandboxGpuConfig: effectiveSandboxGpuConfig ?? null,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          toolDisclosure: effectiveToolDisclosure,
          dcodeAutoApprovalMode: createIntent?.dcodeAutoApprovalMode ?? null,
          observabilityEnabled: createIntent?.observabilityEnabled === true,
          policyTier: createIntent?.policyTier ?? null,
        },
      });
    let pendingStateRestoreBackupPath: string | null = null,
      preparedSandboxWorkload!: Awaited<ReturnType<typeof ensurePreparedSandboxWorkload>>,
      hermesStateVolumeLifecycle!: ReturnType<typeof prepareHermesStateVolumeLifecycle>;
    if (!liveExists && existingEntry)
      ({ runtime: recreateRuntime, backupPath: pendingStateRestoreBackupPath } =
        recreateProtection.selectJournalBoundPreUpgradeBackup({
          runtime: recreateRuntime,
          openJournal: createIntent?.recreateTransaction ? null : openRecreateJournal,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          readRegistryEntry: () => registry.getSandbox(sandboxName),
          observe: () => getSandboxRecreateObservation(sandboxName, GATEWAY_NAME),
        }));

    if (liveExists && !agentCreateInput.hermesPortableLifecycle) {
      const existingSandboxState = getSandboxReuseState(sandboxName);
      const agentDrift = getSandboxAgentDrift(sandboxName, requestedAgentName);
      let recreateForAgentDrift = agentDrift.changed && isRecreateSandbox(createIntent?.recreate);

      if (agentDrift.changed && !isRecreateSandbox(createIntent?.recreate)) {
        console.log(
          `  Sandbox '${sandboxName}' already exists as ${formatSandboxAgentName(agentDrift.existingAgentName)}.`,
        );
        console.log(
          `  ${cliDisplayName()} is onboarding ${formatSandboxAgentName(agentDrift.requestedAgentName)} for this sandbox name.`,
        );
        console.log(
          "  Side-by-side agents are supported, but each sandbox name has one agent type.",
        );
        if (isNonInteractive()) {
          console.error(
            `  Aborting: choose a different name or set NEMOCLAW_RECREATE_SANDBOX=1 to recreate '${sandboxName}'.`,
          );
          console.error(
            `  Example: ${cliName()} onboard --name ${getDefaultSandboxNameForAgent(agent)}`,
          );
          process.exit(1);
        }
        if (
          await promptYesNoOrDefault(
            `  Delete and recreate '${sandboxName}' as ${formatSandboxAgentName(agentDrift.requestedAgentName)}?`,
            null,
            false,
          )
        ) {
          recreateForAgentDrift = true;
        } else {
          console.error("  Aborted. Existing sandbox left unchanged.");
          console.error(
            `  Re-run with a different name, for example: ${cliName()} onboard --name ${getDefaultSandboxNameForAgent(agent)}`,
          );
          process.exit(1);
        }
      }

      // Check whether messaging providers are missing from the gateway. Only
      // force recreation when at least one required provider doesn't exist yet —
      // this avoids destroying sandboxes already created with provider attachments.
      const needsProviderMigration =
        hasMessagingTokens &&
        messagingTokenDefs.some(({ name, token }) => token && !providerExistsInGateway(name));
      const selectionDrift = isManagedDcodeAgent
        ? readManagedDcodeCreateSelectionDrift(
            { sandboxName, provider, model, preferredInferenceApi, createIntent },
            readDcodeSelectionDrift,
          )
        : getSelectionDrift(sandboxName, provider, model, { runOpenshell });
      const actionableSelectionDrift = requiresSelectionRecreate(
        selectionDrift,
        isManagedDcodeAgent,
      );
      const sandboxGpuDrift = hasSandboxGpuDrift(sandboxName, effectiveSandboxGpuConfig);
      const existingSandboxEntry = registry.getSandbox(sandboxName);
      const recordedHermesToolGateways = normalizeHermesToolGatewaySelections(
        existingSandboxEntry?.hermesToolGateways,
      );
      const hermesToolGatewayDrift = !stringSetsEqual(
        recordedHermesToolGateways,
        hermesToolGateways,
      );
      const hermesDashboardDrift = onboardHermesDashboard.hasHermesDashboardDrift({
        agentName: agent?.name,
        existing: existingSandboxEntry,
        state: hermesDashboardState,
      });

      // Detect whether any messaging credential has been rotated since the
      // sandbox was created. Provider credentials are resolved once at sandbox
      // startup, so a rotated token requires a rebuild to take effect.
      const credentialRotation = hasMessagingTokens
        ? detectMessagingCredentialRotation(sandboxName, messagingTokenDefs)
        : { changed: false, changedProviders: [] };

      if (
        !isRecreateSandbox(createIntent?.recreate) &&
        !recreateForAgentDrift &&
        !needsProviderMigration &&
        !sandboxGpuDrift &&
        !credentialRotation.changed &&
        !hermesToolGatewayDrift &&
        !hermesDashboardDrift &&
        !toolDisclosureMigrationNeeded &&
        !observabilityDrift &&
        !dcodeAutoApprovalPlan.hasDrift
      ) {
        // Guard against reusing a CPU-only sandbox when GPU passthrough is enabled.
        // Placed before the non-interactive / interactive split so all reuse
        // paths are covered (interactive prompt, non-interactive ready, unknown drift).
        // Note: legacy registries had gpuEnabled always true (bug fixed in this PR),
        // so gpuEnabled=true on a legacy entry doesn't guarantee GPU support.
        // The gateway Docker-inspect check (above) catches legacy CPU-only gateways
        // before we reach this point, so a legacy sandbox behind a verified GPU
        // gateway is safe to reuse — the sandbox will be recreated if needed.
        if (effectiveSandboxGpuConfig.sandboxGpuEnabled) {
          const entry = registry.getSandbox(sandboxName);
          if (entry && !entry.gpuEnabled) {
            console.error(
              `  Sandbox '${sandboxName}' exists but was created without GPU passthrough.`,
            );
            console.error(
              "  Pass --recreate-sandbox to recreate with GPU, or destroy and re-onboard:",
            );
            console.error(`    nemoclaw onboard --recreate-sandbox`);
            process.exit(1);
          }
        }

        if (isNonInteractive()) {
          if (existingSandboxState === "ready") {
            if (actionableSelectionDrift) {
              note("  [non-interactive] Recreating sandbox due to provider/model drift.");
            } else {
              policyPresetCarry.seedReusedSandboxPolicyPresets(sandboxName, isNonInteractive());
              // Upsert messaging providers even on reuse so credential changes take
              // effect without requiring a full sandbox recreation.
              upsertMessagingProviders(messagingTokenDefs);
              if (selectionDrift.unknown) {
                note(
                  "  [non-interactive] Existing provider/model selection is unreadable; reusing sandbox.",
                );
                note(
                  "  [non-interactive] Set NEMOCLAW_RECREATE_SANDBOX=1 (or --recreate-sandbox) to force recreation.",
                );
              } else {
                note(
                  `  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`,
                );
                note(
                  "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.",
                );
              }
              await restoreReusedSandboxDashboard(!selectionDrift.unknown);
              return sandboxName;
            }
          } else {
            notReadyRecreateInProgress = true;
            const outcome = recreateProtection.resolveNotReadyOutcome();
            if (outcome.kind === "blocked") {
              for (const hint of outcome.hints) console.error(hint);
              process.exit(1);
            }
            pendingStateRestoreBackupPath = outcome.restoreBackupPath;
          }
        } else if (existingSandboxState === "ready") {
          if (actionableSelectionDrift) {
            const confirmed = await confirmRecreateForSelectionDrift(
              sandboxName,
              selectionDrift,
              provider,
              model,
            );
            if (!confirmed) {
              console.error("  Aborted. Existing sandbox left unchanged.");
              process.exit(1);
            }
          } else {
            console.log(`  Sandbox '${sandboxName}' already exists.`);
            console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
            if (await promptYesNoOrDefault("  Reuse existing sandbox?", null, true)) {
              policyPresetCarry.seedReusedSandboxPolicyPresets(sandboxName, isNonInteractive());
              upsertMessagingProviders(messagingTokenDefs);
              await restoreReusedSandboxDashboard(!selectionDrift.unknown);
              return sandboxName;
            }
          }
        } else {
          console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
          console.log("  Selecting 'n' will abort onboarding.");
          if (!(await promptYesNoOrDefault("  Delete it and create a new one?", null, true))) {
            console.log("  Aborting onboarding.");
            process.exit(1);
          }
        }
      }

      if (credentialRotation.changed && existingSandboxState === "ready") {
        const rotatedNames = credentialRotation.changedProviders.join(", ");
        console.log(`  Messaging credential(s) rotated: ${rotatedNames}`);
        console.log("  Rebuilding sandbox to propagate new credentials to the L7 proxy...");
        if (!shouldSkipPreRecreateBackup(process.env)) {
          const result = recreateProtection.backup();
          if (!result.ok) {
            console.error(
              "  Set NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 to recreate without preserving state.",
            );
            process.exit(1);
          }
          pendingStateRestore = result.backup;
        }
      }
      reportSandboxRecreateReason(
        {
          sandboxName,
          recreateForAgentDrift,
          existingAgentName: agentDrift.existingAgentName,
          requestedAgentName: agentDrift.requestedAgentName,
          needsProviderMigration,
          actionableSelectionDrift,
          sandboxGpuDrift,
          hermesToolGatewayDrift,
          hermesDashboardDrift,
          observabilityDrift,
          dcodeAutoApprovalDrift: dcodeAutoApprovalPlan.hasDrift,
          toolDisclosureMigrationNote,
          credentialRotationChanged: credentialRotation.changed,
          existingSandboxState,
        },
        { formatSandboxAgentName, note },
      );
      const managedMcpRebuildHandoff = hasPreservedManagedMcpRebuildHandoff(
        preservedMcpState,
        createIntent,
      );
      if (shouldRefuseManagedMcpRecreate(preservedMcpState, managedMcpRebuildHandoff)) {
        for (const hint of recreateJournal.managedMcpRecreateRefusalHints({
          sandboxName,
          cliName: cliName(),
          toolDisclosure: effectiveToolDisclosure,
          rebuildFlag: dcodeAutoApprovalPlan.rebuildFlag,
          observabilityFlag: observabilityCommandFlag.explicitObservabilityFlag(
            createIntent?.observabilityEnabled === true,
            createIntent?.observabilityRequestedExplicitly === true,
          ),
        }))
          console.error(hint);
        process.exit(1);
      }
      // Resolve and validate immutable workload authority before opening a recreate journal or
      // mutating a live sandbox.
      preparedSandboxWorkload = await ensurePreparedSandboxWorkload();
      await hermesApiPortReservationScope.selectAndReserve(hermesApiPortReservationInput);
      if (!createIntent?.recreateTransaction) recreateRuntime = openRecreateJournal();
      if (recreateRuntime.acceptedTarget) {
        if ("complete" in recreateRuntime) recreateRuntime.complete();
        await restoreReusedSandboxDashboard(true);
        return sandboxName;
      }
      const previousEntry: SandboxEntry | null = registry.getSandbox(sandboxName);
      baseImageResolutionFlow.captureBaseResolution(
        baseImageResolutionContext,
        previousEntry?.imageTag,
      );
      policyPresetCarry.applyRecreatePolicyCarryForward(
        sandboxName,
        isNonInteractive(),
        note,
        createIntent?.rebuildPolicyPresets,
      );

      const noRestorePending =
        pendingStateRestore === null && pendingStateRestoreBackupPath === null;
      if (
        noRestorePending &&
        !notReadyRecreateInProgress &&
        !shouldSkipPreRecreateBackup(process.env)
      ) {
        note("  Backing up workspace state before recreating sandbox...");
        const result = recreateProtection.backup();
        if (!result.ok) {
          console.error(
            "  Set NEMOCLAW_RECREATE_WITHOUT_BACKUP=1 to recreate without preserving state.",
          );
          process.exit(1);
        }
        pendingStateRestore = result.backup;
      }

      hermesStateVolumeLifecycle = prepareHermesStateVolumeLifecycle(preparedSandboxWorkload);
      note(`  Deleting and recreating sandbox '${sandboxName}'...`);

      if (recreateRuntime.beginDelete() === "source") {
        runSandboxProviderPreDeleteCleanup(sandboxName, { runOpenshell, redact });
        runOpenshell(
          [
            "sandbox",
            "delete",
            "-g",
            recreateRuntime.journaledGatewayName ?? GATEWAY_NAME,
            sandboxName,
          ],
          { ignoreError: true },
        );
        if (
          !waitForSandboxRecreateDeleteAbsence(
            sandboxName,
            recreateRuntime.journaledGatewayName ?? GATEWAY_NAME,
            note,
          )
        )
          throw new Error(
            `Cannot continue sandbox '${sandboxName}' recreation: OpenShell did not confirm explicit source absence after delete.`,
          );
      }
      recreateRuntime.confirmDeleted();
      sandboxLifecycle.removeSandboxUnlessSessionReservation(previousEntry, sandboxName);
      await hermesApiPortReservationScope.rebindAfterOwnedForwardDelete(
        hermesApiPortReservationInput,
      );
    }
    if (!liveExists || agentCreateInput.hermesPortableLifecycle) {
      if (!agentCreateInput.hermesPortableLifecycle) {
        await hermesApiPortReservationScope.selectAndReserve(hermesApiPortReservationInput);
      }
      preparedSandboxWorkload = await ensurePreparedSandboxWorkload();
      hermesStateVolumeLifecycle = prepareHermesStateVolumeLifecycle(preparedSandboxWorkload);
    }
    sandboxCreatePlanMaterialization.applyOrdinaryExtraProviderReconciliation(
      agentCreateInput.hermesPortableLifecycle,
      () =>
        applyExtraProviderReconciliation({
          extraProviders: resolvedCreateIntent.extraProviders,
          staleExtraProviders: resolvedCreateIntent.staleExtraProviders ?? [],
        }),
    );
    const preparedOnboardLaunch =
      await managedWorkloadOnboard.prepareSelectedOnboardSandboxWorkloadLaunch(
        agentCreateInput.hermesPortableLifecycle,
        () =>
          managedWorkloadOnboard.prepareHermesPortableOnboardSandboxLaunch({
            intent: resolvedCreateIntent,
            fromRef:
              preparedSandboxWorkload.source.kind === "legacy-dockerfile"
                ? preparedSandboxWorkload.source.dockerfilePath
                : "",
            launchInput: {
              agent,
              observabilityEnabled: false,
              chatUiUrl: "",
              sandboxName,
              env: process.env,
              extraPlaceholderKeys: resolvedCreateIntent.extraPlaceholderKeys,
              getDashboardForwardPort,
              hermesDashboardState: { enabled: false, config: null },
              hermesApiPort: null,
              manageDashboard: false,
              openshellShellCommand,
              openshellArgv,
            },
            gpuConfig: effectiveSandboxGpuConfig,
          }),
        () =>
          managedWorkloadOnboard.prepareOnboardSandboxWorkloadLaunch({
            runtime: managedWorkloadRuntime,
            workload: preparedSandboxWorkload,
            legacy: {
              preparedBuildContext,
              agent,
              fromDockerfile,
              createAgentSandbox: (selectedAgent) =>
                baseImageResolutionFlow.createAgentSandboxWithResolution(
                  baseImageResolutionContext,
                  selectedAgent,
                  agentOnboard.createAgentSandbox,
                ),
              resolvePatchInput: () => ({
                preparedBuildContext,
                agent,
                fromDockerfile,
                model,
                chatUiUrl,
                provider,
                endpointUrl: createIntent?.endpointUrl ?? null,
                compatibleEndpointReasoning: createIntent?.compatibleEndpointReasoning,
                preferredInferenceApi,
                webSearchConfig,
                toolDisclosure: effectiveToolDisclosure,
                rebuildPreservedEnv: createIntent?.rebuildPreservedEnv,
                ...(isManagedDcodeAgent
                  ? { dcodeAutoApprovalMode: dcodeAutoApprovalPlan.mode }
                  : {}),
                hermesToolGateways,
                sandboxGpuConfig: effectiveSandboxGpuConfig,
                ...baseImageResolutionFlow.getBaseImageResolutionPatchOptions(
                  baseImageResolutionContext,
                ),
                gatewayPort: GATEWAY_PORT,
              }),
            },
            plan: {
              intent: resolvedCreateIntent,
              rebindMessagingTokenDefs: async () =>
                (
                  await sandboxCreateIntentResolver.rebind(
                    {
                      sandboxName,
                      enabledChannels,
                      webSearchConfig,
                      agent,
                      ...(createIntent?.reuseRegisteredCredentials
                        ? { reuseRegisteredCredentials: true }
                        : {}),
                    },
                    resolvedCreateIntent,
                  )
                ).messagingTokenDefs,
              runProviderPreDeleteCleanup: () =>
                runSandboxProviderPreDeleteCleanup(sandboxName, {
                  runOpenshell,
                  redact,
                  tolerateMissingSandbox: true,
                }),
              upsertMessagingProviders,
              getHermesToolGatewayProviderName: (targetSandbox) =>
                getHermesToolGatewayBroker().getHermesToolGatewayProviderName(targetSandbox),
              discloseInitialSandboxPolicy,
            },
            launchInput: {
              agent,
              observabilityEnabled: createIntent?.observabilityEnabled === true,
              chatUiUrl,
              sandboxName,
              env: process.env,
              extraPlaceholderKeys: resolvedCreateIntent.extraPlaceholderKeys,
              getDashboardForwardPort,
              hermesDashboardState: agentCreateInput.hermesPortableLifecycle
                ? { enabled: false, config: null }
                : hermesDashboardState,
              hermesApiPort: hermesApiPortReservationScope.effectivePort,
              manageDashboard,
              openshellShellCommand,
              openshellArgv,
            },
            plannedMessagingPlan: plannedMessagingState?.plan ?? null,
            gpu: {
              provider,
              config: effectiveSandboxGpuConfig,
              dockerDriverGateway: agentCreateInput.dockerDriverGateway,
              gatewayPort: GATEWAY_PORT,
            },
            dependencies: {
              materializeSandboxCreatePlan: (input) =>
                hermesStateVolumeLifecycle.materializeSandboxCreatePlan(
                  input,
                  sandboxCreatePlanMaterialization.materializeSandboxCreatePlan,
                ),
              prepareSandboxBuildPatchConfig:
                sandboxBuildPatchConfig.prepareSandboxBuildPatchConfig,
            },
          }),
      );
    const {
      initialSandboxPolicy,
      policyTier: resolvedCreatePolicyTier,
      messagingProviders,
      gpuRoutePlan,
      compatibilityPolicyPath,
      initialGpuRoute,
      sandboxReadyTimeoutSecs,
      buildId,
      dashboardRemoteBindPrepared,
      legacyBuildContext,
      launch: {
        createArgv,
        effectiveDashboardPort,
        intendedSandboxStartupCommand,
        managedBootstrapIdentity,
        managedStartupRootApplyRequest,
        prebuild,
        sandboxEnv,
        sandboxStartupCommand,
      },
    } = preparedOnboardLaunch;
    const restoreBackupPath =
      pendingStateRestore?.manifest?.backupPath ?? pendingStateRestoreBackupPath;
    onboardSessionBootstrap.verifyReadOnlyHostMountSources(resolvedCreateIntent.hostMounts);
    if (!agentCreateInput.hermesPortableLifecycle) recreateRuntime.advance("creating");
    const managedBootstrap = managedWorkloadOnboard.resolveOnboardManagedBootstrapLaunch({
      runtime: managedWorkloadRuntime,
      workload: preparedSandboxWorkload,
      stateRoot: getDockerDriverGatewayStateDir(),
      bootstrapIdentity: managedBootstrapIdentity,
      request: managedStartupRootApplyRequest,
      intendedWorkloadArgv: intendedSandboxStartupCommand,
    });
    const createdSandboxLifecycle = sandboxRecreateTransaction.createCreatedSandboxLifecycle(
      recreateRuntime,
      { sandboxName, gatewayName: GATEWAY_NAME },
      getSandboxRecreateObservation,
    );
    const hermesPortableAuthority = agentCreateInput.hermesPortableLifecycle
      ? (() => {
          if (!agent || agent.name !== "hermes" || !portableRuntimeAuthority) {
            throw new Error(
              "Hermes portable onboarding is missing exact agent or runtime authority.",
            );
          }
          return { agent, runtimeAuthority: portableRuntimeAuthority };
        })()
      : null;
    const hermesGpuAuthority = hermesPortableAuthority
      ? sandboxGpuCreateFlow.createHermesPortableGpuProofAuthority({
          sandboxName,
          gatewayName: GATEWAY_NAME,
          sourceEnv: sandboxEnv,
          lifecycleGeneration: createdSandboxLifecycle.generation,
          runtimeAuthority: hermesPortableAuthority.runtimeAuthority,
          runOpenshell,
          compactText,
          redact,
        })
      : null;
    const createFlowEnvironment = hermesGpuAuthority?.env ?? sandboxEnv;
    const createGpuVerifier = hermesGpuAuthority?.verify ?? verifyDirectSandboxGpu;
    const runCreateFlow = (
      attemptCreateArgv: string[],
      hermesPortableReadyCapture?: import("../sandbox-gpu-create-flow").HermesPortableReadyCapture,
      hermesPortableReadyRunner?: import("../sandbox-gpu-create-flow").HermesPortableReadyRunner,
      createWorkingDirectory?: string,
    ) =>
      sandboxGpuCreateFlow.runSandboxGpuCreateFlow(
        {
          sandboxName,
          provider,
          sandboxGpuConfig: effectiveSandboxGpuConfig,
          gpuRoutePlan,
          initialGpuRoute,
          compatibilityPolicyPath,
          gatewayPort: GATEWAY_PORT,
          sandboxReadyTimeoutSecs,
          createArgv: attemptCreateArgv,
          ...(createWorkingDirectory ? { createWorkingDirectory } : {}),
          sandboxEnv: createFlowEnvironment,
          sandboxStartupCommand,
          lifecycleGeneration: createdSandboxLifecycle.generation,
          portableRuntimeAuthority,
          prebuild,
          restoreBackupPath,
          terminalAgent: agentDefs.isTerminalAgent(agent),
          managedBootstrap,
          ...agentCreateInput,
        },
        {
          runOpenshell: hermesPortableReadyRunner ?? runOpenshell,
          runCaptureOpenshell: hermesPortableReadyCapture ?? runCaptureOpenshell,
          sleep: sleepSeconds,
          openshellArgv,
          verifyDirectSandboxGpu: createGpuVerifier,
        },
      );

    const cleanupBuildContext =
      sandboxGpuCreateFlow.createSandboxBuildContextCleanup(legacyBuildContext);
    const cleanupInitialCreateSource = sandboxGpuCreateFlow.createSandboxCreateSourceCleanup(
      initialSandboxPolicy,
      agentCreateInput.hermesPortableLifecycle,
    );
    const sandboxRuntimeFields = agentCreateInput.hermesPortableLifecycle
      ? sandboxRegistryMetadata.getHermesPortableSandboxRuntimeRegistryFields(
          effectiveSandboxGpuConfig,
          HERMES_PORTABLE_OPENSHELL_VERSION,
        )
      : getSandboxRuntimeRegistryFields(effectiveSandboxGpuConfig);
    const createdSandboxCompletion = createOnboardCreatedSandboxCompletion(
      sandboxName,
      restoreBackupPath,
      pendingStateRestoreBackupPath,
      agent,
      fromDockerfile,
      { customOpenClawImage, isManagedDcodeAgent },
      { provider, model, preferredInferenceApi, endpointUrl: createIntent?.endpointUrl ?? null },
      { createIntent, resolvedCreateIntent },
      sandboxRuntimeFields,
      agentCreateInput.portableLifecycle,
      {
        toolDisclosure: effectiveToolDisclosure,
        dcodeAutoApprovalMode: dcodeAutoApprovalPlan.mode,
      },
      { webSearchConfig, hermesAuthMethod: normalizeHermesAuthMethod(hermesAuthMethod) },
      { plannedMessagingState, preservedMcpState, hermesToolGateways },
      hermesApiPortReservationScope.effectivePort,
      { gatewayName: GATEWAY_NAME, gatewayPort: GATEWAY_PORT },
      { initialSandboxPolicy, policyTier: resolvedCreatePolicyTier, dashboardRemoteBindPrepared },
      prebuild.imageRef,
      buildId,
      effectiveSandboxGpuConfig,
      agentCreateInput.dockerDriverGateway,
      createGpuVerifier,
      runCaptureOpenshell,
      chatUiUrl,
      hermesDashboardState,
      dashboardPortReservationScope.release,
      ensureDashboardForward,
      getDashboardForwardPort,
      hermesDashboardForwarding.resolveStateForPort,
      hermesDashboardForwarding.ensureForState,
      managedWorkloadRuntime,
      preparedSandboxWorkload,
      note,
    );
    const completeCreatedSandboxRegistration = createOnboardCreatedSandboxRegistration({
      completion: createdSandboxCompletion,
      createdLifecycle: createdSandboxLifecycle,
      cleanupBuildContext,
      manageDashboard,
      sandboxGpuEnabled: effectiveSandboxGpuConfig.sandboxGpuEnabled,
    });

    const providerPreparationInput = {
      openshellDriver: sandboxRuntimeFields.openshellDriver,
      inferenceProvider: resolvedCreateIntent.inferenceProvider,
      messagingProviders,
      messagingProviderRequests: resolvedCreateIntent.messagingProviderRequests,
      extraProviders: resolvedCreateIntent.extraProviders,
      gatewayName: GATEWAY_NAME,
    };
    const providerPreparationDeps = {
      providerExistsInGateway,
      runOpenshell,
      cleanupCreateSources: () => {
        cleanupInitialCreateSource();
        cleanupBuildContext();
      },
    };
    validateAttachedMessagingProvidersBeforeSandboxCreation(
      providerPreparationInput,
      providerPreparationDeps,
    );

    if (hermesPortableAuthority) {
      if (!portableRuntimeContext?.environmentScope) {
        throw new Error("Hermes portable onboarding is missing runtime environment authority.");
      }
      if (managedBootstrap || !["none", "native-only"].includes(gpuRoutePlan)) {
        throw new Error(
          "Hermes portable onboarding cannot use managed bootstrap or Docker GPU compatibility.",
        );
      }
      if (!inferenceRouteReservationAuthority?.sessionId) {
        throw new Error(
          "Hermes portable onboarding is missing current inference route reservation authority.",
        );
      }
      const inferenceRouteReservation = {
        sessionId: inferenceRouteReservationAuthority.sessionId,
        selection: sandboxRegistration.selection(
          sandboxName,
          provider,
          model,
          preferredInferenceApi,
          createIntent?.endpointSource ?? null,
        ),
      };
      await sandboxGpuCreateFlow.runHermesPortableOnboardingFromOnboard<
        import("../sandbox-gpu-create-flow").SandboxGpuCreateFlowResult
      >({
        sandboxName,
        gatewayName: GATEWAY_NAME,
        lifecycleGeneration: createdSandboxLifecycle.generation,
        portableRuntime: portableRuntimeContext,
        createArgv,
        createPolicyPath: initialSandboxPolicy.policyPath,
        startup: {
          agent: hermesPortableAuthority.agent,
          sandboxName,
          startupArgv: intendedSandboxStartupCommand,
        },
        inferenceRouteReservation,
        withLifecycleLock: sandboxMutationLock.withMcpLifecycleLock,
        childEnv: sandboxEnv,
        openshellArgv,
        createSandbox: (attemptArgv, readyCapture, readyRunner, buildContextPath) =>
          runCreateFlow([...attemptArgv], readyCapture, readyRunner, buildContextPath),
        readRegistry: () => registry.getSandbox(sandboxName),
        registerSandbox: async (
          created,
          receipt,
          liveIdentityFingerprint,
          revalidate,
          routeReservation,
        ) =>
          completeHermesPortableSandboxRegistration({
            sandboxName,
            completeRegistration: () =>
              completeCreatedSandboxRegistration(
                created,
                receipt,
                liveIdentityFingerprint,
                revalidate,
                routeReservation,
              ),
            readRegistry: registry.getSandbox,
          }),
        sourceRoot: ROOT,
        buildContextSettings: {
          model,
          provider,
          preferredInferenceApi,
          toolDisclosure: effectiveToolDisclosure,
        },
        cleanupTemporaryPolicy: cleanupInitialCreateSource,
        createPolicySourceBytes: initialSandboxPolicy.sourceBytes,
      });
      cleanupBuildContext();
    } else {
      publishAttachedProvidersBeforeDockerSandboxCreation(
        providerPreparationInput,
        providerPreparationDeps,
      );
      const created = await runCreateFlow(createArgv);
      cleanupInitialCreateSource();
      await completeCreatedSandboxRegistration(created, null);
    }
    hermesStateVolumeLifecycle.commit();
    if ("complete" in recreateRuntime) recreateRuntime.complete();
    if (agentCreateInput.hermesPortableLifecycle) return sandboxName;
    return completeOrdinaryOnboardSandboxCreation(
      {
        sandboxName,
        sandboxWasLiveDefault,
        runtimeFields: sandboxRuntimeFields,
        messagingProviders,
        liveExists,
      },
      {
        setDefault: registry.setDefault,
        runFile,
        scriptsDir: SCRIPTS,
        gatewayName: GATEWAY_NAME,
        providerExistsInGateway,
        armCancelRollback: sandboxCancelRollback.arm,
        dockerInfoFormat,
        runCapture,
      },
    );
  };
}
