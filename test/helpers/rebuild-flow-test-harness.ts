// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { makePreparedRecoveryManifest } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import type { RebuildRecreateOnboardOpts } from "../../src/lib/actions/sandbox/rebuild-gpu-opt-out";
import {
  createRebuildFlowSession,
  installTerminalStepFailureMock,
  originalSandboxName,
  type RebuildFlowHarness,
  type RebuildFlowOverrides,
} from "./rebuild-flow-test-support";

export { originalSandboxName, snapshotEnv } from "./rebuild-flow-test-support";

const requireDist = createRequire(
  new URL("../../src/lib/actions/sandbox/rebuild-flow.test.ts", import.meta.url),
);
const rebuildModulePath = "./rebuild.js";
requireDist(rebuildModulePath);
delete require.cache[requireDist.resolve(rebuildModulePath)];
const harnessTempDirs: string[] = [];

// Cache stable dependency modules outside each test's timeout. The rebuild
// entry itself is still reloaded after these modules receive fresh spies.
const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
const dockerInspect = requireDist("../../adapters/docker/inspect.js");
const sandboxList = requireDist("../../openshell-sandbox-list.js");
const resolve = requireDist("../../adapters/openshell/resolve.js");
const agentDefs = requireDist("../../agent/defs.js");
const agentRuntime = requireDist("../../agent/runtime.js");
const { rebuildOnboardDependencies } = requireDist("./rebuild-onboard-dependencies.js");
const onboardCredentialEnv = requireDist("../../onboard/credential-env.js");
const hermesProviderAuth = requireDist("../../hermes-provider-auth.js");
const onboardSession = requireDist("../../state/onboard-session.js");
const registry = requireDist("../../state/registry.js");
const sandboxState = requireDist("../../state/sandbox.js");
const sandboxSession = requireDist("../../state/sandbox-session.js");
const sandboxVersion = requireDist("../../sandbox/version.js");
const destroy = requireDist("./destroy.js");
const gatewayState = requireDist("./gateway-state.js");
const rebuildFlowHelpers = requireDist("./rebuild-flow-helpers.js");
const rebuildCustomImagePreflight = requireDist("./rebuild-custom-image-preflight.js");
const rebuildPreparedImageContext = requireDist("./rebuild-prepared-image-context.js");
const buildContextFingerprint = requireDist("../../adapters/fs/build-context-fingerprint.js");
const rebuildUsageNotice = requireDist("./rebuild-usage-notice.js");
const rebuildShields = requireDist("./rebuild-shields.js");
const nim = requireDist("../../inference/nim.js");
const policies = requireDist("../../policy/index.js");
const processRecovery = requireDist("./process-recovery.js");
const messagingHostForwardLifecycle = requireDist("./messaging-host-forward-lifecycle.js");
const mcpBridge = requireDist("./mcp-bridge.js");
const messaging = requireDist("../../messaging/index.js");
const shields = requireDist("../../shields/index.js");

export function createRebuildFlowHarness(overrides: RebuildFlowOverrides = {}): RebuildFlowHarness {
  delete require.cache[requireDist.resolve(rebuildModulePath)];

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const session = createRebuildFlowSession(onboardSession.MACHINE_SNAPSHOT_VERSION);
  const rebuildShieldsWindow = { relocked: false, wasLocked: false };
  const agentDef = {
    name:
      typeof overrides.sandboxEntry?.agent === "string" ? overrides.sandboxEntry.agent : "openclaw",
    expectedVersion: "0.2.0",
  };

  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
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
  const preparedBuildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-flow-image-"));
  harnessTempDirs.push(preparedBuildCtx);
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
  vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true);
  const warnUnpreservedUserManagedFilesSpy = vi
    .spyOn(rebuildFlowHelpers, "warnUnpreservedUserManagedFiles")
    .mockImplementation(() => undefined);
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agentDef);
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "openclaw" });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
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
  vi.spyOn(hermesProviderAuth, "inspectHermesProviderBinding").mockReturnValue({
    exists: overrides.hermesProviderExists ?? true,
    credentialKeys:
      (overrides.hermesProviderExists ?? true)
        ? (overrides.hermesCredentialKeys ?? ["OPENAI_API_KEY"])
        : null,
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
  vi.spyOn(registry, "load").mockImplementation(() => {
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
  const runOpenshellSpy = vi
    .spyOn(openshellRuntime, "runOpenshell")
    .mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      return overrides.runOpenshell ? overrides.runOpenshell(argv) : { status: 0, output: "" };
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
  vi.spyOn(rebuildOnboardDependencies, "preflightAuthoritativeRebuildTarget").mockResolvedValue(
    undefined,
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
    rebuildSandbox: requireDist(rebuildModulePath).rebuildSandbox,
    applyPresetSpy,
    backupSandboxStateSpy,
    errorSpy,
    executeSandboxCommandSpy,
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
    session,
  };
}

export function installRebuildFlowTestHooks(): void {
  beforeEach(() => {
    delete process.env.NEMOCLAW_SANDBOX_NAME;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve(rebuildModulePath)];
    for (const dir of harnessTempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (originalSandboxName === undefined) {
      delete process.env.NEMOCLAW_SANDBOX_NAME;
    } else {
      process.env.NEMOCLAW_SANDBOX_NAME = originalSandboxName;
    }
  });
}
