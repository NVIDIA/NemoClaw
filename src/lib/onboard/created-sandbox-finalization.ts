// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  OpenClawImagePluginInstall,
  OpenClawManagedExtensionDiscoveryResult,
} from "../state/openclaw-plugin-restore";
import * as openClawPluginRestore from "../state/openclaw-plugin-restore";
import type { SandboxEntry, SandboxGpuProofResult } from "../state/registry";
import type { QualifiedSandboxInferenceRouteReservation } from "../state/registry/route-reservation";
import type { SandboxWorkloadReceipt } from "../state/registry/types";
import {
  MANAGED_SNAPSHOT_RESTORE_AUTHORITY_ERROR,
  OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR,
  type RecreatedSandboxRestoreOptions,
  type RestoreResult,
} from "../state/sandbox";
import * as sandboxState from "../state/sandbox";
import * as buildContext from "../build-context";
import { resolveSandboxImageTagFromCreateOutput } from "../domain/sandbox/image-tag";
import { restoreDefaultAfterRecreate } from "./default-preservation";
import { createDcodeSelectionDriftReader } from "./dcode-selection-drift";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import type { HermesDashboardOnboardState } from "./hermes-dashboard";
import type { HermesPortableConfiguredReceipt } from "./experimental/hermes-portable-receipt";
import { warnIfLandlockUnsupported } from "./landlock-warning";
import * as managedWorkloadOnboard from "./managed-workload/onboard-orchestration";
import { printMessagingProviderMissing } from "./preflight-messages";
import { pendingSandboxPolicyVerificationForBoundary } from "./sandbox-create/policy-creation-receipt";
import type { SandboxGpuCreateFlowResult } from "./sandbox-gpu-create-flow";
import type { VerifiedSandboxPolicyBoundary, VerifiedSandboxPolicyRegistration } from "./types";
import type { SelectionDrift } from "./selection-drift";
import { applyOnboardVmDnsMonkeypatch } from "./vm-dns-monkeypatch";
import {
  creationFidelity,
  registerCreatedSandbox,
  selection,
  type CreatedSandboxRegistrationInput,
} from "./sandbox-registration";
import type {
  CreatedSandboxLifecycle,
  CreatedSandboxLifecycleRegistration,
} from "./sandbox-recreate-transaction";

export type CreatedSandboxFinalizationOptions = {
  sandboxName: string;
  gatewayName?: string;
  restoreBackupPath: string | null;
  preUpgradeBackup: boolean;
  targetAgentType: string;
  customImage?: boolean;
  discoverOpenClawImagePluginInstalls?: boolean;
  validateManagedDcode: boolean;
  provider: string;
  model: string;
  preferredInferenceApi: string | null;
  endpointUrl?: string | null;
};

export type CreatedSandboxFinalizationDeps = {
  revalidatePolicyAuthority?(operation: string): void;
  discoverFreshOpenClawImagePluginInstalls(
    sandboxName: string,
  ): OpenClawManagedExtensionDiscoveryResult;
  restoreRecreatedSandboxState(
    sandboxName: string,
    backupPath: string,
    options: RecreatedSandboxRestoreOptions,
  ): RestoreResult;
  getDcodeSelectionDrift(
    sandboxName: string,
    provider: string,
    model: string,
    preferredInferenceApi: string | null,
    endpointUrl: string | null,
  ): SelectionDrift;
  register(
    openclawImagePluginInstalls?: readonly OpenClawImagePluginInstall[],
  ): SandboxEntry | void;
  note(message: string): void;
  error(message: string): void;
  exitProcess(code: number): never;
};

type WorkloadResolutionInput = Parameters<
  typeof managedWorkloadOnboard.resolveOnboardSandboxWorkloadReceipt
>[0];
type RegistrationSeed = Omit<
  CreatedSandboxRegistrationInput,
  | "imageTag"
  | "workload"
  | "openclawImagePluginInstalls"
  | "hermesDashboardState"
  | "dashboardPort"
  | "lifecycleGeneration"
  | "lifecycleLiveIdentityFingerprint"
  | "inferenceRouteReservation"
  | "verifiedCreate"
>;

export interface CreatedSandboxCompletionOptions {
  readonly finalization: CreatedSandboxFinalizationOptions;
  readonly registration: RegistrationSeed;
  readonly policy: {
    readonly initialPolicyPath: string;
    readonly compatibilityPolicyPath: string | null;
    readonly getVerifiedPolicyBoundary: () => VerifiedSandboxPolicyBoundary;
    readonly getVerifiedCreateRegistrationAuthority: () => NonNullable<
      CreatedSandboxRegistrationInput["verifiedCreate"]
    >;
  };
  readonly gpu: {
    readonly config: Parameters<
      typeof dockerGpuLocalInference.verifyGpuSandboxLocalInferenceAndCommitAfterReady
    >[0];
    readonly provider: string;
    readonly dockerDriverGateway: boolean;
    readonly verifyDirectSandboxGpu: (sandboxName: string) => SandboxGpuProofResult;
    readonly runCaptureOpenshell: NonNullable<
      Parameters<
        typeof dockerGpuLocalInference.verifyGpuSandboxLocalInferenceAndCommitAfterReady
      >[2]["runCaptureOpenshell"]
    >;
  };
  readonly dashboard: {
    readonly chatUiUrl: string;
    readonly initialHermesState: HermesDashboardOnboardState;
    readonly releasePort: () => Promise<void>;
    readonly ensureForward: (
      sandboxName: string,
      chatUiUrl: string,
      options: {
        rollbackSandboxOnFailure: true;
        revalidatePolicyAuthority?: (operation: string) => void;
      },
    ) => number;
    readonly getForwardPort: (chatUiUrl: string) => string;
    readonly resolveHermesState: (port: number) => HermesDashboardOnboardState;
    readonly ensureHermesForward: (
      state: HermesDashboardOnboardState,
      sandboxName: string,
      rollback: true,
      revalidatePolicyAuthority?: (operation: string) => void,
    ) => void;
  };
  readonly workload: Omit<
    WorkloadResolutionInput,
    "registryImageRef" | "firstCreateOutput" | "createOutput"
  >;
}

export interface CreatedSandboxCompletionDeps extends Omit<
  CreatedSandboxFinalizationDeps,
  "register"
> {
  readonly registerCreatedSandbox?: typeof registerCreatedSandbox;
}

export interface CreatedSandboxCompletionActions {
  complete(
    created: SandboxGpuCreateFlowResult | null,
    configuredReceipt: HermesPortableConfiguredReceipt | null,
    providerGpuDisposition: "disabled" | "created" | "hermes",
    manageDashboard: boolean,
    resolveLifecycleRegistrationFields: () => Pick<SandboxEntry, "lifecycleGeneration">,
    lifecycle: CreatedSandboxLifecycle,
    inferenceRouteReservation?: QualifiedSandboxInferenceRouteReservation,
  ): Promise<SandboxEntry | void>;
}

type OnboardCreatedSandboxRegistration = (
  created: SandboxGpuCreateFlowResult | null,
  configuredReceipt: HermesPortableConfiguredReceipt | null,
  configuredLiveIdentityFingerprint?: string,
  revalidateHermesAuthority?: () => string,
  inferenceRouteReservation?: QualifiedSandboxInferenceRouteReservation,
) => Promise<SandboxEntry | void>;

/** Bind the post-create registration callback to its finalization authorities. */
export function createOnboardCreatedSandboxRegistration(input: {
  readonly completion: CreatedSandboxCompletionActions;
  readonly createdLifecycle: CreatedSandboxLifecycle;
  readonly cleanupBuildContext: () => void;
  readonly manageDashboard: boolean;
  readonly sandboxGpuEnabled: boolean;
}): OnboardCreatedSandboxRegistration {
  return async (
    created,
    configuredReceipt,
    configuredLiveIdentityFingerprint,
    revalidate,
    inferenceRouteReservation,
  ) => {
    if (!created && !configuredReceipt) {
      throw new Error("Sandbox registration requires create or Hermes receipt authority.");
    }
    if (!created) {
      throw new Error(
        "Hermes portable resume cannot publish sandbox authority without a verified create checkpoint from this process.",
      );
    }
    input.cleanupBuildContext();
    const providerGpuDisposition = !input.sandboxGpuEnabled
      ? "disabled"
      : configuredReceipt
        ? "hermes"
        : "created";
    const lifecycle = configuredReceipt
      ? createHermesPortableCreatedSandboxLifecycle(
          configuredReceipt,
          revalidate ??
            (() => {
              throw new Error(
                "Hermes portable registry publication has no revalidation authority.",
              );
            }),
        )
      : input.createdLifecycle;
    await input.completion.complete(
      created,
      configuredReceipt,
      providerGpuDisposition,
      input.manageDashboard,
      () =>
        configuredReceipt
          ? {
              lifecycleGeneration: configuredReceipt.lifecycleGeneration,
              lifecycleLiveIdentityFingerprint: configuredLiveIdentityFingerprint,
            }
          : created!.lifecycleRegistrationFields,
      lifecycle,
      inferenceRouteReservation,
    );
  };
}

/** Finish ordinary post-registration actions after portable onboarding has returned. */
export function completeOrdinaryOnboardSandboxCreation(
  input: {
    readonly sandboxName: string;
    readonly sandboxWasLiveDefault: boolean;
    readonly runtimeFields: RegistrationSeed["runtimeFields"];
    readonly messagingProviders: readonly string[];
    readonly liveExists: boolean;
    readonly lifecycleLiveIdentityFingerprint?: string;
  },
  deps: {
    readonly setDefault: (sandboxName: string) => void;
    readonly runFile: (command: string, args: string[], options: { ignoreError: true }) => unknown;
    readonly scriptsDir: string;
    readonly gatewayName: string;
    readonly providerExistsInGateway: (providerName: string) => boolean;
    readonly armCancelRollback: (sandboxName: string, sandboxIdentityFingerprint: string) => void;
    readonly markCancellationRecovery: (sandboxName: string) => unknown;
    readonly dockerInfoFormat: Parameters<typeof warnIfLandlockUnsupported>[0]["dockerInfoFormat"];
    readonly runCapture: Parameters<typeof warnIfLandlockUnsupported>[0]["runCapture"];
    readonly revalidatePolicyAuthority: (operation: string) => void;
    readonly applyVmDnsMonkeypatch?: typeof applyOnboardVmDnsMonkeypatch;
  },
): string {
  deps.revalidatePolicyAuthority(`completing sandbox '${input.sandboxName}'`);
  restoreDefaultAfterRecreate(deps.setDefault, input.sandboxName, input.sandboxWasLiveDefault);
  deps.revalidatePolicyAuthority(`starting DNS setup for sandbox '${input.sandboxName}'`);
  if (input.runtimeFields.openshellDriver === "kubernetes") {
    console.log("  Setting up sandbox DNS proxy...");
    deps.runFile(
      "bash",
      [path.join(deps.scriptsDir, "setup-dns-proxy.sh"), deps.gatewayName, input.sandboxName],
      { ignoreError: true },
    );
    deps.revalidatePolicyAuthority(`applying DNS settings for sandbox '${input.sandboxName}'`);
  }
  (deps.applyVmDnsMonkeypatch ?? applyOnboardVmDnsMonkeypatch)(
    input.sandboxName,
    input.runtimeFields,
    { revalidatePolicyAuthority: deps.revalidatePolicyAuthority },
  );
  for (const provider of input.messagingProviders) {
    if (!deps.providerExistsInGateway(provider)) printMessagingProviderMissing(provider);
  }
  deps.revalidatePolicyAuthority(`reporting sandbox '${input.sandboxName}' creation success`);
  console.log(`  ✓ Sandbox '${input.sandboxName}' created`);
  warnIfLandlockUnsupported(deps);
  if (!input.liveExists) {
    const lifecycleLiveIdentityFingerprint = input.lifecycleLiveIdentityFingerprint;
    if (
      !lifecycleLiveIdentityFingerprint ||
      !/^[0-9a-f]{64}$/u.test(lifecycleLiveIdentityFingerprint)
    ) {
      deps.markCancellationRecovery(input.sandboxName);
      for (const line of [
        "",
        `  Sandbox '${input.sandboxName}' was created on gateway '${deps.gatewayName}', but NemoClaw could not verify its durable identity.`,
        "  The sandbox registry entry and onboarding session were preserved for recovery.",
        "  Do not delete the sandbox by mutable sandbox name.",
        "  Ask an OpenShell administrator to establish the exact live durable identity before removal.",
        "  After confirmed identity-bound removal, rerun the original onboarding command with the same required inputs, add --fresh, and use a new sandbox name.",
      ]) {
        console.error(line);
      }
      throw new Error(`Sandbox '${input.sandboxName}' has no exact identity for cancel recovery.`);
    }
    deps.armCancelRollback(input.sandboxName, lifecycleLiveIdentityFingerprint);
  }
  return input.sandboxName;
}

/** Revalidate the configuring receipt at both registry-publication checks. */
export function createHermesPortableCreatedSandboxLifecycle(
  receipt: HermesPortableConfiguredReceipt,
  revalidate: () => string,
): CreatedSandboxLifecycle {
  const requireCurrent = () => ({
    lifecycleGeneration: receipt.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: revalidate(),
  });
  return {
    generation: receipt.lifecycleGeneration,
    recordExactIdentity: (liveIdentityFingerprint) => {
      const current = requireCurrent();
      if (current.lifecycleLiveIdentityFingerprint !== liveIdentityFingerprint) {
        throw new Error("Hermes portable created identity disagrees with receipt authority.");
      }
      return current;
    },
    capture: (fields) => {
      if (fields.lifecycleGeneration !== receipt.lifecycleGeneration) {
        throw new Error("Hermes portable registry generation disagrees with receipt authority.");
      }
      return requireCurrent();
    },
    revalidate: (registration) => {
      const current = requireCurrent();
      if (
        registration.lifecycleGeneration !== current.lifecycleGeneration ||
        registration.lifecycleLiveIdentityFingerprint !== current.lifecycleLiveIdentityFingerprint
      ) {
        throw new Error("Hermes portable registry publication disagrees with receipt authority.");
      }
      return current;
    },
  };
}

/** Keep post-Ready action bodies with the finalization owner while onboarding retains decisions. */
export function createCreatedSandboxCompletionActions(
  options: CreatedSandboxCompletionOptions,
  deps: CreatedSandboxCompletionDeps,
): CreatedSandboxCompletionActions {
  let chatUiUrl = options.dashboard.chatUiUrl;
  let dashboardPort = 0;
  let hermesDashboardState = options.dashboard.initialHermesState;
  async function verifyCreatedProviderGpu(created: SandboxGpuCreateFlowResult): Promise<void> {
    await dockerGpuLocalInference.verifyGpuSandboxLocalInferenceAndCommitAfterReady(
      options.gpu.config,
      options.gpu.provider,
      {
        sandboxName: options.finalization.sandboxName,
        dockerDriverGateway: options.gpu.dockerDriverGateway,
        selectedRoute: created.route,
        verifyDirectSandboxGpu: options.gpu.verifyDirectSandboxGpu,
        runCaptureOpenshell: options.gpu.runCaptureOpenshell,
        log: console.log,
      },
      created.runtimePatch,
      () =>
        deps.revalidatePolicyAuthority?.(
          `committing GPU capability for sandbox '${options.finalization.sandboxName}'`,
        ),
    );
  }
  function recordHermesGpuProof(): void {
    options.gpu.config.sandboxGpuProof = options.gpu.verifyDirectSandboxGpu(
      options.finalization.sandboxName,
    );
  }
  async function finalizeDashboard(): Promise<void> {
    await options.dashboard.releasePort();
    deps.revalidatePolicyAuthority?.(
      `configuring dashboard capability for sandbox '${options.finalization.sandboxName}'`,
    );
    dashboardPort = options.dashboard.ensureForward(options.finalization.sandboxName, chatUiUrl, {
      rollbackSandboxOnFailure: true,
      revalidatePolicyAuthority: deps.revalidatePolicyAuthority,
    });
    deps.revalidatePolicyAuthority?.(
      `configuring dashboard capability for sandbox '${options.finalization.sandboxName}'`,
    );
    if (dashboardPort !== Number(options.dashboard.getForwardPort(chatUiUrl))) {
      chatUiUrl = `http://127.0.0.1:${dashboardPort}`;
    }
    process.env.CHAT_UI_URL = chatUiUrl;
    hermesDashboardState = options.dashboard.resolveHermesState(dashboardPort);
    deps.revalidatePolicyAuthority?.(
      `configuring Hermes dashboard capability for sandbox '${options.finalization.sandboxName}'`,
    );
    options.dashboard.ensureHermesForward(
      hermesDashboardState,
      options.finalization.sandboxName,
      true,
      deps.revalidatePolicyAuthority,
    );
    deps.revalidatePolicyAuthority?.(
      `recording Hermes dashboard capability for sandbox '${options.finalization.sandboxName}'`,
    );
  }
  return {
    complete: async (
      created,
      configuredReceipt,
      providerGpuDisposition,
      manageDashboard,
      resolveLifecycleRegistrationFields,
      lifecycle,
      inferenceRouteReservation,
    ) => {
      const verifiedLifecycle = lifecycle.revalidate(
        lifecycle.capture(resolveLifecycleRegistrationFields()),
      );
      const verifiedPolicyBoundary = options.policy.getVerifiedPolicyBoundary();
      assertVerifiedPolicyBoundaryMatchesLifecycle(
        verifiedPolicyBoundary,
        options.finalization.sandboxName,
        options.registration.gatewayName,
        options.registration.gatewayPort,
        verifiedLifecycle,
      );
      deps.revalidatePolicyAuthority?.(
        `finalizing verified policy for sandbox '${options.finalization.sandboxName}'`,
      );
      if (providerGpuDisposition === "created") {
        deps.revalidatePolicyAuthority?.(
          `committing GPU capability for sandbox '${options.finalization.sandboxName}'`,
        );
        await verifyCreatedProviderGpu(created!);
      } else if (providerGpuDisposition === "hermes") {
        deps.revalidatePolicyAuthority?.(
          `recording GPU capability for sandbox '${options.finalization.sandboxName}'`,
        );
        recordHermesGpuProof();
      }
      if (manageDashboard) {
        deps.revalidatePolicyAuthority?.(
          `configuring dashboard capability for sandbox '${options.finalization.sandboxName}'`,
        );
        await finalizeDashboard();
      }
      const resolved = managedWorkloadOnboard.resolveOnboardSandboxWorkloadReceipt({
        ...options.workload,
        registryImageRef: created?.registryImageRef ?? configuredReceipt?.container.imageId ?? null,
        firstCreateOutput: created?.origin === "created" ? created.firstCreateOutput : "",
        createOutput: created?.origin === "created" ? created.createResult.output : "",
      });
      const finalLifecycle = lifecycle.revalidate(verifiedLifecycle);
      assertVerifiedPolicyBoundaryMatchesLifecycle(
        verifiedPolicyBoundary,
        options.finalization.sandboxName,
        options.registration.gatewayName,
        options.registration.gatewayPort,
        finalLifecycle,
      );
      deps.revalidatePolicyAuthority?.(
        `publishing sandbox '${options.finalization.sandboxName}' registry authority`,
      );
      const verifiedPolicyRegistration = verifiedPolicyBoundary.registration;
      return finalizeCreatedSandbox(
        { ...options.finalization, gatewayName: options.registration.gatewayName },
        {
          ...deps,
          register: (openclawImagePluginInstalls) => {
            const verifiedCreate = options.policy.getVerifiedCreateRegistrationAuthority();
            assertVerifiedCreateMatchesPolicyBoundary(verifiedPolicyBoundary, verifiedCreate);
            const verifiedInferenceRouteReservation = verifiedCreate.reservation;
            if (
              inferenceRouteReservation &&
              !isDeepStrictEqual(inferenceRouteReservation, verifiedInferenceRouteReservation)
            ) {
              throw new Error(
                "Sandbox registration inference route differs from its verified create reservation.",
              );
            }
            return (deps.registerCreatedSandbox ?? registerCreatedSandbox)({
              ...options.registration,
              inferenceSelection: verifiedInferenceRouteReservation.authority.selection,
              runtimeFields: {
                ...options.registration.runtimeFields,
                sandboxGpuProof:
                  options.gpu.config.sandboxGpuProof ??
                  options.registration.runtimeFields.sandboxGpuProof,
                openshellVersion:
                  configuredReceipt?.openshellExecutableAuthority.version ??
                  options.registration.runtimeFields.openshellVersion,
              },
              hermesPortableLifecycle: configuredReceipt !== null,
              imageTag: resolved.resolvedImageTag,
              workload: resolved.workloadReceipt,
              openclawImagePluginInstalls,
              hermesDashboardState,
              dashboardPort,
              ...finalLifecycle,
              appliedPolicies:
                verifiedPolicyRegistration.policyAuthority === "externally-managed"
                  ? []
                  : options.registration.appliedPolicies,
              policyAuthority: verifiedPolicyRegistration.policyAuthority,
              ...(verifiedPolicyRegistration.policyAuthority === "nemoclaw-managed"
                ? {
                    policyCreationReceipt: verifiedPolicyRegistration.policyCreationReceipt,
                  }
                : {}),
              inferenceRouteReservation: verifiedInferenceRouteReservation,
              verifiedCreate,
            });
          },
        },
      );
    },
  };
}

function assertVerifiedCreateMatchesPolicyBoundary(
  boundary: VerifiedSandboxPolicyBoundary,
  verifiedCreate: NonNullable<CreatedSandboxRegistrationInput["verifiedCreate"]>,
): void {
  if (
    !isDeepStrictEqual(
      verifiedCreate.checkpoint,
      pendingSandboxPolicyVerificationForBoundary(boundary),
    )
  ) {
    throw new Error("Verified sandbox create checkpoint does not match final policy authority.");
  }
}

function assertVerifiedPolicyBoundaryMatchesLifecycle(
  boundary: VerifiedSandboxPolicyBoundary,
  sandboxName: string,
  gatewayName: string,
  gatewayPort: number,
  lifecycle: CreatedSandboxLifecycleRegistration,
): VerifiedSandboxPolicyRegistration {
  if (
    boundary.sandboxName !== sandboxName ||
    boundary.gatewayName !== gatewayName ||
    boundary.gatewayPort !== gatewayPort ||
    boundary.lifecycleGeneration !== lifecycle.lifecycleGeneration ||
    boundary.lifecycleLiveIdentityFingerprint !== lifecycle.lifecycleLiveIdentityFingerprint
  ) {
    throw new Error("Verified sandbox policy authority does not match the final lifecycle.");
  }
  return boundary.registration;
}

type OnboardCreateIntent = {
  readonly endpointSource?: RegistrationSeed["inferenceSelection"]["endpointSource"];
  readonly observabilityEnabled?: boolean;
} | null;
type OnboardResolvedCreateIntent = {
  readonly policy: {
    readonly options: {
      readonly baselineExclusions: NonNullable<RegistrationSeed["baselineExclusions"]>;
    };
  };
  readonly hostMounts?: RegistrationSeed["hostMounts"];
};
type OnboardCreateContext = {
  readonly createIntent: OnboardCreateIntent;
  readonly resolvedCreateIntent: OnboardResolvedCreateIntent;
};
type OnboardAgentFlags = {
  readonly customOpenClawImage: boolean;
  readonly isManagedDcodeAgent: boolean;
};
type OnboardInferenceSelection = {
  readonly provider: string;
  readonly model: string;
  readonly preferredInferenceApi: string | null;
  readonly endpointUrl: string | null;
};
type OnboardMessagingRegistration = {
  readonly plannedMessagingState: RegistrationSeed["plannedMessagingState"];
  readonly preservedMcpState: RegistrationSeed["preservedMcpState"];
  readonly hermesToolGateways: string[];
};
type OnboardCreationFidelity = {
  readonly webSearchConfig: Parameters<typeof creationFidelity>[0];
  readonly hermesAuthMethod: Parameters<typeof creationFidelity>[2];
};
type OnboardPolicyRegistration = {
  readonly toolDisclosure: RegistrationSeed["toolDisclosure"];
  readonly dcodeAutoApprovalMode: RegistrationSeed["dcodeAutoApprovalMode"];
};
type OnboardGatewayBinding = {
  readonly gatewayName: string;
  readonly gatewayPort: number;
};
type OnboardPreparedPolicy = Omit<
  Pick<
    managedWorkloadOnboard.PreparedOnboardSandboxWorkloadLaunch,
    "initialSandboxPolicy" | "policyTier" | "policyAuthority" | "dashboardRemoteBindPrepared"
  >,
  "policyAuthority"
> & {
  readonly policyAuthority: NonNullable<SandboxEntry["policyAuthority"]>;
  readonly compatibilityPolicyPath: string | null;
  readonly getVerifiedPolicyBoundary: () => VerifiedSandboxPolicyBoundary;
  readonly getVerifiedCreateRegistrationAuthority: () => NonNullable<
    CreatedSandboxRegistrationInput["verifiedCreate"]
  >;
  readonly revalidatePolicyAuthority: (operation: string) => void;
};

/** Assemble the exact post-Ready owners without adding an onboarding decision. */
export function createOnboardCreatedSandboxCompletion(
  sandboxName: string,
  restoreBackupPath: string | null,
  pendingStateRestoreBackupPath: string | null,
  agent: RegistrationSeed["agent"],
  fromDockerfile: string | null,
  agentFlags: OnboardAgentFlags,
  inference: OnboardInferenceSelection,
  createContext: OnboardCreateContext,
  runtimeFields: RegistrationSeed["runtimeFields"],
  portableLifecycle: boolean,
  policyRegistration: OnboardPolicyRegistration,
  creation: OnboardCreationFidelity,
  messaging: OnboardMessagingRegistration,
  hermesApiPort: number | null,
  gateway: OnboardGatewayBinding,
  preparedPolicy: OnboardPreparedPolicy,
  prebuildImageRef: string | null,
  buildId: string,
  gpuConfig: CreatedSandboxCompletionOptions["gpu"]["config"],
  dockerDriverGateway: boolean,
  verifyDirectSandboxGpu: CreatedSandboxCompletionOptions["gpu"]["verifyDirectSandboxGpu"],
  runCaptureOpenshell: CreatedSandboxCompletionOptions["gpu"]["runCaptureOpenshell"],
  chatUiUrl: string,
  initialHermesDashboardState: HermesDashboardOnboardState,
  releaseDashboardPort: CreatedSandboxCompletionOptions["dashboard"]["releasePort"],
  ensureDashboardForward: CreatedSandboxCompletionOptions["dashboard"]["ensureForward"],
  getDashboardForwardPort: CreatedSandboxCompletionOptions["dashboard"]["getForwardPort"],
  resolveHermesDashboardState: CreatedSandboxCompletionOptions["dashboard"]["resolveHermesState"],
  ensureHermesDashboardForward: CreatedSandboxCompletionOptions["dashboard"]["ensureHermesForward"],
  workloadRuntime: WorkloadResolutionInput["runtime"],
  workload: WorkloadResolutionInput["workload"],
  note: (message: string) => void,
): CreatedSandboxCompletionActions {
  const { provider, model, preferredInferenceApi, endpointUrl } = inference;
  const { createIntent, resolvedCreateIntent } = createContext;
  return createCreatedSandboxCompletionActions(
    {
      finalization: {
        sandboxName,
        restoreBackupPath,
        preUpgradeBackup: pendingStateRestoreBackupPath !== null,
        targetAgentType: agent?.name ?? "openclaw",
        customImage: Boolean(fromDockerfile),
        discoverOpenClawImagePluginInstalls: agentFlags.customOpenClawImage,
        validateManagedDcode: agentFlags.isManagedDcodeAgent,
        provider,
        model,
        preferredInferenceApi,
        endpointUrl,
      },
      registration: {
        sandboxName,
        inferenceSelection: selection(
          sandboxName,
          provider,
          model,
          preferredInferenceApi,
          createIntent?.endpointSource ?? null,
        ),
        runtimeFields,
        agent,
        agentVersionKnown: !fromDockerfile,
        portableLifecycle,
        appliedPolicies:
          preparedPolicy.policyAuthority === "externally-managed"
            ? []
            : preparedPolicy.initialSandboxPolicy.appliedPresets,
        policyAuthority: preparedPolicy.policyAuthority,
        toolDisclosure: policyRegistration.toolDisclosure,
        observabilityEnabled: createIntent?.observabilityEnabled === true,
        ...(agentFlags.isManagedDcodeAgent
          ? { dcodeAutoApprovalMode: policyRegistration.dcodeAutoApprovalMode }
          : {}),
        policyTier: preparedPolicy.policyTier,
        ...creationFidelity(
          creation.webSearchConfig,
          fromDockerfile,
          creation.hermesAuthMethod,
          preparedPolicy.dashboardRemoteBindPrepared,
          resolvedCreateIntent.policy.options.baselineExclusions,
        ),
        ...messaging,
        hermesApiPort,
        ...gateway,
        hostMounts: resolvedCreateIntent.hostMounts,
      },
      policy: {
        initialPolicyPath: preparedPolicy.initialSandboxPolicy.policyPath,
        compatibilityPolicyPath: preparedPolicy.compatibilityPolicyPath,
        getVerifiedPolicyBoundary: preparedPolicy.getVerifiedPolicyBoundary,
        getVerifiedCreateRegistrationAuthority:
          preparedPolicy.getVerifiedCreateRegistrationAuthority,
      },
      gpu: {
        config: gpuConfig,
        provider,
        dockerDriverGateway,
        verifyDirectSandboxGpu,
        runCaptureOpenshell,
      },
      dashboard: {
        chatUiUrl,
        initialHermesState: initialHermesDashboardState,
        releasePort: releaseDashboardPort,
        ensureForward: ensureDashboardForward,
        getForwardPort: getDashboardForwardPort,
        resolveHermesState: resolveHermesDashboardState,
        ensureHermesForward: ensureHermesDashboardForward,
      },
      workload: {
        runtime: workloadRuntime,
        workload,
        prebuildImageRef,
        buildId,
        extractBuiltImageRef: buildContext.extractBuiltImageRef,
        resolveSandboxImageTagFromCreateOutput,
      },
    },
    {
      discoverFreshOpenClawImagePluginInstalls: (name) =>
        openClawPluginRestore.discoverFreshOpenClawImagePluginInstalls(
          name,
          sandboxState,
          agent?.configPaths.dir,
        ),
      restoreRecreatedSandboxState: sandboxState.restoreRecreatedSandboxState,
      getDcodeSelectionDrift: createDcodeSelectionDriftReader(
        runCaptureOpenshell,
        () => gateway.gatewayName,
      ),
      note,
      error: console.error,
      exitProcess: (code) => process.exit(code),
      revalidatePolicyAuthority: preparedPolicy.revalidatePolicyAuthority,
    },
  );
}

/** Restore state and validate the live managed DCode route before registry publication. */
export function finalizeCreatedSandbox(
  options: CreatedSandboxFinalizationOptions,
  deps: CreatedSandboxFinalizationDeps,
): SandboxEntry | void {
  const reportUnregisteredSandboxRecovery = (): void => {
    deps.error(
      `  NemoClaw left unregistered sandbox '${options.sandboxName}' in place because OpenShell can delete it only by mutable name.`,
    );
    deps.error("  Verify its durable identity before manual cleanup; do not act by name alone.");
  };
  let freshOpenClawImagePluginInstalls: readonly OpenClawImagePluginInstall[] | undefined;
  if (options.discoverOpenClawImagePluginInstalls === true) {
    const discovery = deps.discoverFreshOpenClawImagePluginInstalls(options.sandboxName);
    if (!discovery.ok) {
      deps.error(
        `  OpenClaw image plugin discovery failed for sandbox '${options.sandboxName}': ${discovery.error}`,
      );
      deps.error("  State was not restored and registry metadata was not updated.");
      reportUnregisteredSandboxRecovery();
      deps.error("  Then rerun the original `nemoclaw onboard --from <Dockerfile>` command.");
      if (options.restoreBackupPath) deps.error(`  Manual recovery: ${options.restoreBackupPath}`);
      return deps.exitProcess(1);
    }
    freshOpenClawImagePluginInstalls = discovery.pluginInstalls;
  }

  if (options.restoreBackupPath) {
    deps.note(
      options.preUpgradeBackup
        ? "  Restoring workspace state from pre-upgrade backup..."
        : "  Restoring workspace state from pre-recreate backup...",
    );
    deps.revalidatePolicyAuthority?.(`restoring files for sandbox '${options.sandboxName}'`);
    const restore = deps.restoreRecreatedSandboxState(
      options.sandboxName,
      options.restoreBackupPath,
      {
        targetAgentType: options.targetAgentType,
        ...(options.customImage ? { allowCustomImageWholeStateFileRestore: true } : {}),
        ...(freshOpenClawImagePluginInstalls !== undefined
          ? { freshOpenClawImagePluginInstalls }
          : {}),
      },
    );
    deps.revalidatePolicyAuthority?.(
      `reporting restored state for sandbox '${options.sandboxName}'`,
    );
    if (restore.success) {
      deps.note(
        `  ✓ State restored (${restore.restoredDirs.length} directories, ${restore.restoredFiles.length} files)`,
      );
    } else {
      if (restore.error === MANAGED_SNAPSHOT_RESTORE_AUTHORITY_ERROR) {
        deps.error(
          `  Managed snapshot restore is deferred for newly created sandbox '${options.sandboxName}' until its runtime authority can be bound before registry publication.`,
        );
        deps.error("  State was not restored and registry metadata was not updated.");
        reportUnregisteredSandboxRecovery();
        deps.error(`  Manual recovery: ${options.restoreBackupPath}`);
        return deps.exitProcess(1);
      }
      if (restore.error === OPENCLAW_IMAGE_PLUGIN_PROVENANCE_RESTORE_ERROR) {
        deps.error(
          `  OpenClaw image plugin provenance validation failed for sandbox '${options.sandboxName}': ${restore.error}`,
        );
        deps.error(
          "  The sandbox still exists, but registry metadata was not updated because a future rebuild would be unsafe.",
        );
        reportUnregisteredSandboxRecovery();
        deps.error("  Then rerun the original `nemoclaw onboard --from <Dockerfile>` command.");
        deps.error(`  Manual recovery: ${options.restoreBackupPath}`);
        return deps.exitProcess(1);
      }
      // Source-of-truth review:
      // - Invalid state: a fresh sandbox exists after an external workspace copy fails.
      // - Boundary: restore.success owns copy completeness; live validation owns route integrity.
      // - Source-fix constraint: rollback must span sandbox creation and external copies.
      // - Regression: the partial-workspace-restore test validates fresh config before registration.
      // - Removal: drop this fallback when restore failure can roll back sandbox creation atomically.
      deps.error(
        `  Warning: workspace state restore was incomplete for sandbox '${options.sandboxName}'.`,
      );
      if (restore.failedDirs.length > 0) {
        deps.error(`  Failed directories: ${restore.failedDirs.join(", ")}`);
      }
      if (restore.failedFiles.length > 0) {
        deps.error(`  Failed files: ${restore.failedFiles.join(", ")}`);
      }
      if (restore.error) deps.error(`  Restore reason: ${restore.error}`);
      deps.error(
        "  Workspace state restoration did not complete. Registry metadata was not updated.",
      );
      reportUnregisteredSandboxRecovery();
      deps.error(`  Keep the snapshot for manual recovery: ${options.restoreBackupPath}`);
      return deps.exitProcess(1);
    }
  }

  if (options.validateManagedDcode) {
    const finalSelection = deps.getDcodeSelectionDrift(
      options.sandboxName,
      options.provider,
      options.model,
      options.preferredInferenceApi,
      options.endpointUrl ?? null,
    );
    if (finalSelection.changed || finalSelection.unknown) {
      deps.error(
        `  DCode live model/provider validation failed for sandbox '${options.sandboxName}'. The sandbox still exists, but its live route is unverified and registry metadata was not updated.`,
      );
      deps.error(
        "  A NemoClaw rebuild is unsafe here because no verified registry metadata exists.",
      );
      reportUnregisteredSandboxRecovery();
      deps.error("  Then rerun the original `nemoclaw onboard` command.");
      if (options.restoreBackupPath) {
        deps.error(`  Manual recovery: ${options.restoreBackupPath}`);
      }
      return deps.exitProcess(1);
    }
  }

  deps.revalidatePolicyAuthority?.(`registering sandbox '${options.sandboxName}'`);
  return deps.register(freshOpenClawImagePluginInstalls);
}
