// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { makePreparedRecoveryManifest } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import type { RebuildRecreateOnboardOpts } from "../../src/lib/actions/sandbox/rebuild-gpu-opt-out";
import {
  agentDefs,
  agentRuntime,
  buildContextFingerprint,
  createHarnessTempDir,
  createRebuildFlowSession,
  destroy,
  dockerInspect,
  gatewayDrift,
  gatewayState,
  gatewayTeardownAuthority,
  hermesProviderAuth,
  installTerminalStepFailureMock,
  loadRebuildSandbox,
  mcpBridge,
  messaging,
  messagingHostForwardLifecycle,
  nim,
  onboardCredentialEnv,
  onboardSession,
  openshellRuntime,
  policies,
  processRecovery,
  purgeRebuildModule,
  type RebuildFlowHarness,
  type RebuildFlowOverrides,
  rebuildCustomImagePreflight,
  rebuildFlowHelpers,
  rebuildOnboardDependencies,
  rebuildPreparedImageContext,
  rebuildRoutePreflight,
  rebuildShields,
  rebuildUsageNotice,
  registry,
  registryPersistence,
  resolve,
  sandboxList,
  sandboxSession,
  sandboxState,
  sandboxVersion,
  shields,
  sourceSandboxGateway,
} from "./rebuild-flow-harness";

export {
  installRebuildFlowTestHooks,
  originalSandboxName,
  portableAgentLifecycle,
  snapshotEnv,
} from "./rebuild-flow-harness";

export function createRebuildFlowHarness(overrides: RebuildFlowOverrides = {}): RebuildFlowHarness {
  purgeRebuildModule();

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const session = createRebuildFlowSession(onboardSession.MACHINE_SNAPSHOT_VERSION);
  const rebuildShieldsWindow = { relocked: false, wasLocked: false };
  let policyAdditionsPath: string | null = null;
  if (typeof overrides.agentPolicyAdditionsContent === "string") {
    const policyDir = createHarnessTempDir("nemoclaw-rebuild-agent-policy-");
    policyAdditionsPath = path.join(policyDir, "policy-additions.yaml");
    fs.writeFileSync(policyAdditionsPath, overrides.agentPolicyAdditionsContent);
  }
  const agentDef = {
    name:
      typeof overrides.sandboxEntry?.agent === "string" ? overrides.sandboxEntry.agent : "openclaw",
    expectedVersion: "0.2.0",
    policyAdditionsPath,
  };
  const resolveGatewayAuthority = ({
    gatewayName,
    gatewayPort,
  }: {
    gatewayName: string;
    gatewayPort: number;
  }) => ({
    gatewayName,
    gatewayPort,
    mode: "nemoclaw-managed" as const,
    source: "standalone" as const,
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  });

  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayTeardownAuthority").mockImplementation(
    resolveGatewayAuthority,
  );
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayRebuildAuthority").mockImplementation(
    resolveGatewayAuthority,
  );
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
    result: {
      status: 0,
      output: overrides.sandboxListOutput ?? (overrides.staleRecovery ? "" : "alpha Ready"),
    },
  });
  vi.spyOn(gatewayState, "getReconciledSandboxGatewayState").mockResolvedValue(
    overrides.reconciledSandboxGatewayState ?? {
      state: overrides.staleRecovery ? "missing" : "present",
      output: "",
    },
  );
  const ensureRebuildAgentBaseImageSpy = vi
    .spyOn(rebuildFlowHelpers, "ensureRebuildAgentBaseImage")
    .mockReturnValue(
      overrides.baseImagePreflight ?? { ok: true, imageRef: null, overrideEnvVar: null },
    );
  vi.spyOn(dockerInspect, "dockerImageInspectFormat").mockReturnValue(
    overrides.sandboxBaseImageLabelsOutput ?? "",
  );
  const ensureTargetGatewaySpy = vi
    .spyOn(rebuildFlowHelpers, "ensureRebuildTargetGatewaySelected")
    .mockResolvedValue(true);
  const preparedBuildCtx = createHarnessTempDir("nemoclaw-rebuild-flow-image-");
  const preparedDockerfile = path.join(preparedBuildCtx, "Dockerfile");
  fs.writeFileSync(preparedDockerfile, "FROM scratch\n");
  const rebuildAgent =
    typeof overrides.sandboxEntry?.agent === "string" ? overrides.sandboxEntry.agent : null;
  const fromDockerfile =
    typeof overrides.sandboxEntry?.fromDockerfile === "string"
      ? path.resolve(overrides.sandboxEntry.fromDockerfile)
      : null;
  const defaultImagePreflight = {
    ok: true as const,
    imageTag: "nemoclaw-rebuild-preflight:test",
    prepared: {
      buildCtx: preparedBuildCtx,
      stagedDockerfile: preparedDockerfile,
      cleanupBuildCtx: () => {
        fs.rmSync(preparedBuildCtx, { recursive: true, force: true });
        return true;
      },
      buildId: "rebuild-flow-prepared",
      contextFingerprint: buildContextFingerprint.fingerprintBuildContext(preparedBuildCtx),
      verifyBuildCtx: rebuildPreparedImageContext.createBuildContextVerifier(
        preparedBuildCtx,
        buildContextFingerprint.fingerprintBuildContext(preparedBuildCtx),
      ),
      rebuildTarget: {
        agentName: rebuildAgent && rebuildAgent !== "openclaw" ? rebuildAgent : null,
        fromDockerfile,
      },
    },
  };
  vi.spyOn(rebuildCustomImagePreflight, "preflightRebuildImage").mockResolvedValue(
    overrides.customImagePreflight ?? defaultImagePreflight,
  );
  const finalizePreparedImageSpy = vi
    .spyOn(rebuildCustomImagePreflight, "finalizePreparedRebuildImageMessagingPlan")
    .mockImplementation(
      (overrides.finalizePreparedImage ??
        ((prepared: typeof defaultImagePreflight.prepared) => ({
          ok: true as const,
          imageTag: "nemoclaw-rebuild-finalize:test",
          prepared,
        }))) as never,
    );
  vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true);
  const warnUnpreservedUserManagedFilesSpy = vi
    .spyOn(rebuildFlowHelpers, "warnUnpreservedUserManagedFiles")
    .mockImplementation(() => undefined);
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agentDef);
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(
    agentDef.name === "openclaw" ? null : ({ name: agentDef.name } as never),
  );
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue(
    agentDef.name === "hermes"
      ? "Hermes Agent"
      : agentDef.name === "langchain-deepagents-code"
        ? "Deep Agents Code"
        : "OpenClaw",
  );
  const defaultHydrateCredentialEnv =
    onboardCredentialEnv.hydrateCredentialEnv.bind(onboardCredentialEnv);
  const hydrateCredentialEnvSpy = vi
    .spyOn(rebuildOnboardDependencies, "hydrateCredentialEnv")
    .mockImplementation((...args: unknown[]) => {
      const credentialEnv = String(args[0] ?? "");
      return overrides.hydrateCredentialEnv
        ? overrides.hydrateCredentialEnv(credentialEnv)
        : defaultHydrateCredentialEnv(credentialEnv);
    });
  vi.spyOn(onboardCredentialEnv, "hydrateCredentialEnv").mockImplementation(
    (...args: unknown[]) => {
      const credentialEnv = String(args[0] ?? "");
      return overrides.hydrateCredentialEnv
        ? overrides.hydrateCredentialEnv(credentialEnv)
        : defaultHydrateCredentialEnv(credentialEnv);
    },
  );
  let hermesProviderExists = overrides.hermesProviderExists ?? true;
  let hermesCredentialKeys = hermesProviderExists
    ? (overrides.hermesCredentialKeys ?? ["OPENAI_API_KEY"])
    : null;
  vi.spyOn(hermesProviderAuth, "inspectHermesProviderBinding").mockImplementation(() => ({
    exists: hermesProviderExists,
    credentialKeys: hermesCredentialKeys,
  }));
  const registerHermesInferenceProviderSpy = vi
    .spyOn(hermesProviderAuth, "registerHermesInferenceProvider")
    .mockImplementation((...args: unknown[]) => {
      hermesProviderExists = true;
      hermesCredentialKeys = [String(args[2] ?? "OPENAI_API_KEY")];
    });
  vi.spyOn(onboardSession, "loadSession").mockReturnValue(session);
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator: unknown) => {
    if (typeof mutator !== "function") {
      throw new TypeError("updateSession expected a mutator function");
    }
    (mutator as (value: typeof session) => typeof session | void)(session);
    return session;
  });
  const releaseOnboardLockSpy = vi
    .spyOn(onboardSession, "releaseOnboardLock")
    .mockImplementation(() => undefined);
  vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true });
  const finalizeIncompleteOnboardStepSpy = installTerminalStepFailureMock(onboardSession, session);
  session.sandboxName = overrides.sessionSandboxName ?? session.sandboxName;
  const modelsCustomOpenClawImage =
    typeof overrides.sandboxEntry?.fromDockerfile === "string" &&
    (!overrides.sandboxEntry.agent || overrides.sandboxEntry.agent === "openclaw");
  const customOpenClawPluginProvenance = modelsCustomOpenClawImage
    ? { openclawImagePluginInstalls: [] }
    : {};
  const currentSandboxEntry = {
    name: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    policies: ["npm"],
    agent: null,
    agentVersion: "0.1.0",
    nimContainer: null,
    nemoclawVersion: "0.1.0",
    dashboardPort: 18789,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    ...customOpenClawPluginProvenance,
    ...(overrides.sandboxEntry ?? {}),
  };
  const readCurrentSandboxEntry = () => structuredClone(currentSandboxEntry);
  vi.spyOn(registry, "getSandbox").mockImplementation(readCurrentSandboxEntry);
  const initialDefaultSandbox = overrides.defaultSandbox ?? null;
  const preDeleteDefaultSandbox =
    overrides.preDeleteDefaultSandbox !== undefined
      ? overrides.preDeleteDefaultSandbox
      : initialDefaultSandbox;
  const initialDefaultSelectionRevision = overrides.defaultSelectionRevision ?? 10;
  const preDeleteDefaultSelectionRevision =
    overrides.preDeleteDefaultSelectionRevision ?? initialDefaultSelectionRevision;
  const preDeleteSandboxEntry = overrides.preDeleteSandboxEntry ?? currentSandboxEntry;
  let currentDefaultSandbox = initialDefaultSandbox;
  let currentDefaultSelectionRevision = initialDefaultSelectionRevision;
  const currentRegistryEntryNames = new Set([String(currentSandboxEntry.name)]);
  if (initialDefaultSandbox) currentRegistryEntryNames.add(initialDefaultSandbox);
  if (preDeleteDefaultSandbox) currentRegistryEntryNames.add(preDeleteDefaultSandbox);
  vi.spyOn(registry, "getDefault").mockImplementation(() => currentDefaultSandbox);
  const setDefaultSpy = vi
    .spyOn(registry, "setDefault")
    .mockImplementation((...args: unknown[]) => {
      currentDefaultSandbox = String(args[0]);
      currentDefaultSelectionRevision++;
      return true;
    });
  let registryLoadCount = 0;
  vi.spyOn(registryPersistence, "load").mockImplementation(() => {
    const isPreDeleteRead = registryLoadCount > 0;
    registryLoadCount++;
    const defaultSandbox = isPreDeleteRead ? preDeleteDefaultSandbox : initialDefaultSandbox;
    const defaultSelectionRevision = isPreDeleteRead
      ? preDeleteDefaultSelectionRevision
      : initialDefaultSelectionRevision;
    const selectedEntry = isPreDeleteRead ? preDeleteSandboxEntry : currentSandboxEntry;
    return {
      sandboxes: {
        alpha: structuredClone(selectedEntry),
        ...(defaultSandbox && defaultSandbox !== "alpha"
          ? { [defaultSandbox]: { name: defaultSandbox } }
          : {}),
      },
      defaultSandbox,
      defaultSelectionRevision,
    };
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  const registryUpdateSpy = vi
    .spyOn(registry, "updateSandbox")
    .mockImplementation((_name, updates) => {
      Object.assign(currentSandboxEntry, updates);
      return true;
    });
  vi.spyOn(rebuildRoutePreflight, "commitRebuildRoutePreflight").mockImplementation(
    (...args: unknown[]) => {
      const input = args[0] as {
        sandboxName: string;
        gatewayName: string;
        targetUpdate: Record<string, unknown>;
      };
      if (!registry.updateSandbox(input.sandboxName, input.targetUpdate)) {
        return {
          ok: false,
          message: "Sandbox registry entry disappeared during rebuild route preflight.",
        };
      }
      return {
        ok: true,
        receipt: {
          sandboxName: input.sandboxName,
          gatewayName: input.gatewayName,
          route: {
            provider: input.targetUpdate.provider ?? null,
            model: input.targetUpdate.model ?? null,
            endpointUrl: input.targetUpdate.endpointUrl ?? null,
            preferredInferenceApi: input.targetUpdate.preferredInferenceApi ?? null,
            credentialEnv: input.targetUpdate.credentialEnv ?? null,
          },
          migratedSandboxNames: [],
        },
      };
    },
  );
  vi.spyOn(rebuildRoutePreflight, "revalidateRebuildRouteBeforeDelete").mockImplementation(
    (...args: unknown[]) => {
      const receipt = args[0] as Record<string, unknown>;
      return overrides.revalidateRebuildRouteBeforeDelete?.(receipt) ?? { ok: true, receipt };
    },
  );
  const restoreSandboxEntrySpy = vi
    .spyOn(registry, "restoreSandboxEntry")
    .mockImplementation((...args: unknown[]) => {
      currentRegistryEntryNames.add(String((args[0] as { name: string }).name));
      const options = (args[1] ?? {}) as Record<string, unknown>;
      const transition = options.defaultTransition as
        | { from: string | null; to: string; expectedRevision: number }
        | undefined;
      if (
        transition &&
        currentDefaultSandbox === transition.from &&
        currentDefaultSelectionRevision === transition.expectedRevision
      ) {
        currentDefaultSandbox = transition.to;
        currentDefaultSelectionRevision++;
      }
    });
  const restoreSandboxEntryIfMissingSpy = vi
    .spyOn(registry, "restoreSandboxEntryIfMissing")
    .mockImplementation((...args: unknown[]) => {
      const receipt = args[0] as Record<string, unknown>;
      const entryName = String((receipt.entry as { name: string }).name);
      if (currentRegistryEntryNames.has(entryName)) return false;
      currentRegistryEntryNames.add(entryName);
      const shouldReclaimDefault =
        receipt.wasDefault === true &&
        currentDefaultSandbox === receipt.fallbackDefault &&
        currentDefaultSelectionRevision === receipt.postRemovalDefaultSelectionRevision;
      const currentDefaultIsValid =
        currentDefaultSandbox !== null && currentRegistryEntryNames.has(currentDefaultSandbox);
      if (shouldReclaimDefault || !currentDefaultIsValid) {
        currentDefaultSandbox = entryName;
        currentDefaultSelectionRevision++;
      }
      return true;
    });
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: false,
    sessions: [],
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockImplementation(() => {
    Object.assign(currentSandboxEntry, overrides.entryUpdatesAfterVersionCheck ?? {});
    return (
      overrides.versionCheck ?? {
        expectedVersion: "0.2.0",
        sandboxVersion: "0.1.0",
        isStale: true,
        verificationFailed: false,
        detectionMethod: "registry",
      }
    );
  });
  vi.spyOn(rebuildShields, "openRebuildShieldsWindow").mockReturnValue(rebuildShieldsWindow);
  const relockSpy = vi
    .spyOn(rebuildShields, "relockRebuildShieldsWindow")
    .mockImplementation((...args: unknown[]) => {
      const window = args[1] as typeof rebuildShieldsWindow;
      window.relocked = true;
      return true;
    });
  const backupSandboxStateSpy = vi
    .spyOn(sandboxState, "backupSandboxState")
    .mockImplementation(() => {
      overrides.beforeBackup?.();
      return {
        success: true,
        backedUpDirs: ["workspace"],
        backedUpFiles: ["user.md"],
        failedDirs: [],
        failedFiles: [],
        manifest: {
          agentType:
            typeof overrides.sandboxEntry?.agent === "string"
              ? overrides.sandboxEntry.agent
              : "openclaw",
          dir: "/sandbox/.openclaw",
          backupPath: "/tmp/nemoclaw-rebuild-backup",
          timestamp: "2026-06-01T00:00:00.000Z",
          policyPresets: overrides.backupPolicyPresets ?? ["npm", "bad", "throw"],
          ...(overrides.backupPreservedEnv
            ? { preservedEnv: structuredClone(overrides.backupPreservedEnv) }
            : {}),
          ...(modelsCustomOpenClawImage
            ? {
                reconcileOpenClawImagePluginProvenance: true,
                openclawImagePluginInstalls: structuredClone(
                  currentSandboxEntry.openclawImagePluginInstalls,
                ),
              }
            : {}),
        },
      };
    });
  vi.spyOn(sandboxState, "validateRebuildRecoveryManifest").mockImplementation(
    (...args: unknown[]) => {
      const manifest = args[2] as Record<string, unknown>;
      return overrides.recoveryManifestValidation?.(manifest) ?? { ok: true, manifest };
    },
  );
  vi.spyOn(sandboxState, "getLatestBackup").mockImplementation(
    () =>
      (overrides.preDeleteLatestManifest === undefined
        ? makePreparedRecoveryManifest()
        : overrides.preDeleteLatestManifest) as ReturnType<typeof sandboxState.getLatestBackup>,
  );
  vi.spyOn(sandboxState, "hasPositiveManagedImageEvidence").mockReturnValue(
    overrides.managedImageEvidence ?? true,
  );
  const restoreSandboxStateSpy = vi
    .spyOn(sandboxState, "restoreRecreatedSandboxState")
    .mockImplementation(
      overrides.restoreSandboxState ??
        (() => ({
          success: true,
          restoredDirs: ["workspace"],
          restoredFiles: ["user.md"],
          failedDirs: [],
          failedFiles: [],
        })),
    );
  const deletedSourceGateways = new Set<string>();
  const runOpenshellSpy = vi
    .spyOn(openshellRuntime, "runOpenshell")
    .mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      const overrideResult = overrides.runOpenshell?.(argv);
      if (overrideResult) return overrideResult;
      const deleteGateway = sourceSandboxGateway(argv, "delete");
      if (deleteGateway) {
        deletedSourceGateways.add(deleteGateway);
        return { status: 0, output: "" };
      }
      if (
        argv.join(" ") === "sandbox get alpha" ||
        argv.join(" ") === "sandbox get -g nemoclaw alpha"
      ) {
        return {
          status: 1,
          output: "sandbox alpha not found",
          stdout: "",
          stderr: "sandbox alpha not found",
        };
      }
      return { status: 0, output: "" };
    });
  const captureOpenshellSpy = vi
    .spyOn(openshellRuntime, "captureOpenshell")
    .mockImplementation((args: unknown, options?: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      if (overrides.captureOpenshell) {
        return overrides.captureOpenshell(argv, options as Record<string, unknown> | undefined);
      }
      const probedGateway = sourceSandboxGateway(argv, "get");
      const liveSource = "Name: alpha\nId: sbx-alpha-source\nPhase: Ready\n";
      return probedGateway && !deletedSourceGateways.has(probedGateway)
        ? { status: 0, output: liveSource, stdout: liveSource, stderr: "" }
        : { status: 1, output: "", stderr: "Error: sandbox alpha not found" };
    });
  const defaultRemovalReceipt = {
    entry: preDeleteSandboxEntry,
    wasDefault: preDeleteDefaultSandbox === "alpha",
    fallbackDefault:
      preDeleteDefaultSandbox && preDeleteDefaultSandbox !== "alpha"
        ? preDeleteDefaultSandbox
        : null,
    postRemovalDefaultSelectionRevision:
      preDeleteDefaultSelectionRevision + (preDeleteDefaultSandbox === "alpha" ? 1 : 0),
  };
  const removeSandboxRegistryEntryWithReceiptSpy = vi
    .spyOn(destroy, "removeSandboxRegistryEntryWithReceipt")
    .mockImplementation(() => {
      const overridden = overrides.removeSandboxRegistryEntryWithReceipt?.();
      const receipt =
        overridden !== undefined
          ? overridden
          : overrides.removalReceipt === undefined
            ? defaultRemovalReceipt
            : overrides.removalReceipt;
      if (receipt) {
        currentRegistryEntryNames.delete(String(receipt.entry.name));
        if (receipt.fallbackDefault) currentRegistryEntryNames.add(receipt.fallbackDefault);
        currentDefaultSandbox = receipt.wasDefault
          ? receipt.fallbackDefault
          : currentDefaultSandbox;
        currentDefaultSelectionRevision = receipt.postRemovalDefaultSelectionRevision;
      }
      return receipt;
    });
  vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined);
  vi.spyOn(nim, "stopNimContainerByName").mockImplementation(() => undefined);
  const onboardSpy = vi
    .spyOn(rebuildOnboardDependencies, "onboard")
    .mockImplementation(async (...args: unknown[]) => {
      const options = args[0] as RebuildRecreateOnboardOpts;
      await overrides.onboard?.(session, options);
    });
  vi.spyOn(rebuildOnboardDependencies, "preflightAuthoritativeRebuildTarget").mockImplementation(
    async (options: unknown) => {
      const preflightOptions = (options ?? {}) as Record<string, unknown>;
      if (overrides.preflightWithProductionBaselineResolver) {
        policies.resolveSandboxBaselinePolicy(String(preflightOptions.sandboxName ?? ""));
      }
      await overrides.preflightAuthoritativeRebuildTarget?.(preflightOptions);
      return {
        gatewayName: String(preflightOptions.targetGatewayName ?? "nemoclaw"),
        gatewayPort: Number(preflightOptions.targetGatewayPort ?? 8080),
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      };
    },
  );
  const ensureValidatedBraveSearchCredentialSpy = vi
    .spyOn(rebuildOnboardDependencies, "ensureValidatedWebSearchCredential")
    .mockImplementation(
      overrides.ensureValidatedWebSearchCredential ??
        overrides.ensureValidatedBraveSearchCredential ??
        (async () => "web-search-key"),
    );
  const livePolicyPresets = new Set<string>();
  const applyPresetSpy = vi
    .spyOn(policies, "applyPreset")
    .mockImplementation((_sandboxName: unknown, presetName: unknown) => {
      const normalizedPresetName = String(presetName);
      let applied: boolean;
      if (overrides.applyPreset) {
        applied = overrides.applyPreset(normalizedPresetName);
      } else if (normalizedPresetName === "throw") {
        throw new Error("preset boom");
      } else {
        applied = normalizedPresetName === "npm";
      }
      if (applied) livePolicyPresets.add(normalizedPresetName);
      return applied;
    });
  vi.spyOn(policies, "getGatewayPresets").mockImplementation(() => [...livePolicyPresets]);
  vi.spyOn(policies, "removePreset").mockImplementation(
    (_sandboxName: unknown, presetName: unknown) => livePolicyPresets.delete(String(presetName)),
  );
  const executeSandboxCommandSpy = vi
    .spyOn(processRecovery, "executeSandboxCommand")
    .mockImplementation(
      overrides.executeSandboxCommand ?? (() => ({ status: 0, stdout: "doctor ok", stderr: "" })),
    );
  const executeSandboxExecCommandSpy = vi
    .spyOn(processRecovery, "executeSandboxExecCommand")
    .mockImplementation(
      overrides.executeSandboxExecCommand ??
        (() => ({ status: 0, stdout: "doctor ok", stderr: "" })),
    );
  const checkAndRecoverSandboxProcessesSpy = vi
    .spyOn(processRecovery, "checkAndRecoverSandboxProcesses")
    .mockImplementation(
      overrides.checkAndRecoverSandboxProcesses ??
        (() => ({
          checked: true,
          wasRunning: true,
          recovered: false,
          forwardRecovered: false,
        })),
    );
  const restartSandboxGatewaySpy = vi
    .spyOn(processRecovery, "restartSandboxGateway")
    .mockImplementation(
      overrides.restartSandboxGateway ??
        (() => ({
          ok: true,
          restarted: true,
          healthPassed: true,
          forwardRecovered: false,
        })),
    );
  vi.spyOn(shields, "repairMutableConfigPerms").mockImplementation(
    overrides.repairMutableConfigPerms ?? (() => ({ applied: true, verified: true, errors: [] })),
  );
  vi.spyOn(shields, "isShieldsDown").mockReturnValue(true);
  vi.spyOn(shields, "clearShieldsState").mockImplementation(
    overrides.clearShieldsState ?? (() => undefined),
  );
  const messagingRebuildPlanSpy = vi
    .spyOn(messaging.MessagingWorkflowPlanner.prototype, "buildRebuildPlanFromSandboxEntry")
    .mockImplementation(overrides.buildMessagingRebuildPlan ?? (() => null));
  const ensureMessagingHostForwardAfterRebuildSpy = vi
    .spyOn(messagingHostForwardLifecycle, "ensureMessagingHostForwardAfterRebuild")
    .mockReturnValue(true);
  const prepareMcpBridgesForRebuildSpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForRebuild")
    .mockResolvedValue(
      overrides.mcpPreparation ?? {
        entries: [],
        detachedProviderEntries: [],
      },
    );
  const prepareMcpBridgesForAbsentSandboxRebuildSpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForAbsentSandboxRebuild")
    .mockResolvedValue(
      overrides.mcpPreparation ?? {
        entries: [],
        detachedProviderEntries: [],
        scrubbedAdapterEntries: [],
      },
    );
  const reattachMcpProvidersAfterRebuildAbortSpy = vi
    .spyOn(mcpBridge, "reattachMcpProvidersAfterRebuildAbort")
    .mockResolvedValue(undefined);
  const restoreMcpBridgesAfterRebuildSpy = vi
    .spyOn(mcpBridge, "restoreMcpBridgesAfterRebuild")
    .mockImplementation(overrides.restoreMcpBridgesAfterRebuild ?? (() => Promise.resolve()));

  errorSpy.mockClear();
  logSpy.mockClear();
  warnSpy.mockClear();

  return {
    rebuildSandbox: loadRebuildSandbox(),
    applyPresetSpy,
    backupSandboxStateSpy,
    checkAndRecoverSandboxProcessesSpy,
    restartSandboxGatewaySpy,
    errorSpy,
    executeSandboxCommandSpy,
    executeSandboxExecCommandSpy,
    ensureMessagingHostForwardAfterRebuildSpy,
    ensureRebuildAgentBaseImageSpy,
    ensureTargetGatewaySpy,
    ensureValidatedBraveSearchCredentialSpy,
    hydrateCredentialEnvSpy,
    logSpy,
    finalizeIncompleteOnboardStepSpy,
    onboardSpy,
    registryUpdateSpy,
    setDefaultSpy,
    setDefault: (name: string) => registry.setDefault(name),
    registerHermesInferenceProviderSpy,
    registerSandboxEntry: (name: string) => {
      currentRegistryEntryNames.add(name);
      if (currentDefaultSandbox === null) {
        currentDefaultSandbox = name;
        currentDefaultSelectionRevision++;
      }
    },
    getDefaultSelectionState: () => ({
      defaultSandbox: currentDefaultSandbox,
      defaultSelectionRevision: currentDefaultSelectionRevision,
    }),
    releaseOnboardLockSpy,
    relockSpy,
    restoreSandboxStateSpy,
    captureOpenshellSpy,
    runOpenshellSpy,
    messagingRebuildPlanSpy,
    prepareMcpBridgesForAbsentSandboxRebuildSpy,
    prepareMcpBridgesForRebuildSpy,
    reattachMcpProvidersAfterRebuildAbortSpy,
    removeSandboxRegistryEntryWithReceiptSpy,
    restoreSandboxEntrySpy,
    restoreSandboxEntryIfMissingSpy,
    restoreMcpBridgesAfterRebuildSpy,
    warnUnpreservedUserManagedFilesSpy,
    finalizePreparedImageSpy,
    session,
  };
}
