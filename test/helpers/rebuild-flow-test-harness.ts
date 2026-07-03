// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, beforeEach, vi } from "vitest";
import { makePreparedRecoveryManifest } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
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

export function createRebuildFlowHarness(overrides: RebuildFlowOverrides = {}): RebuildFlowHarness {
  delete require.cache[requireDist.resolve(rebuildModulePath)];

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
  const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
  const sandboxList = requireDist("../../openshell-sandbox-list.js");
  const resolve = requireDist("../../adapters/openshell/resolve.js");
  const agentDefs = requireDist("../../agent/defs.js");
  const agentRuntime = requireDist("../../agent/runtime.js");
  const onboardMod = requireDist("../../onboard.js");
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
  const rebuildUsageNotice = requireDist("./rebuild-usage-notice.js");
  const rebuildShields = requireDist("./rebuild-shields.js");
  const nim = requireDist("../../inference/nim.js");
  const policies = requireDist("../../policy/index.js");
  const processRecovery = requireDist("./process-recovery.js");
  const messagingHostForwardLifecycle = requireDist("./messaging-host-forward-lifecycle.js");
  const mcpBridge = requireDist("./mcp-bridge.js");
  const messaging = requireDist("../../messaging/index.js");
  const shields = requireDist("../../shields/index.js");

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
  vi.spyOn(gatewayState, "getReconciledSandboxGatewayState").mockResolvedValue({
    state: overrides.staleRecovery ? "missing" : "present",
    output: "",
  });
  vi.spyOn(rebuildFlowHelpers, "ensureRebuildAgentBaseImage").mockReturnValue(
    overrides.baseImagePreflight ?? { ok: true, imageRef: null, overrideEnvVar: null },
  );
  const ensureTargetGatewaySpy = vi
    .spyOn(rebuildFlowHelpers, "ensureRebuildTargetGatewaySelected")
    .mockResolvedValue(true);
  vi.spyOn(rebuildCustomImagePreflight, "preflightRebuildImage").mockResolvedValue(
    overrides.customImagePreflight ?? { ok: true, imageTag: null },
  );
  vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true);
  const warnUnpreservedUserManagedFilesSpy = vi
    .spyOn(rebuildFlowHelpers, "warnUnpreservedUserManagedFiles")
    .mockImplementation(() => undefined);
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agentDef);
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "openclaw" });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
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
  const markStepFailedSpy = installTerminalStepFailureMock(onboardSession, session);
  session.sandboxName = overrides.sessionSandboxName ?? session.sandboxName;
  const sandboxEntry = {
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
    ...(overrides.sandboxEntry ?? {}),
  };
  vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry);
  vi.spyOn(registry, "getDefault").mockReturnValue(overrides.defaultSandbox ?? null);
  let registryLoadCount = 0;
  vi.spyOn(registry, "load").mockImplementation(() => {
    const isPreDeleteRead = registryLoadCount > 0;
    registryLoadCount++;
    const defaultSandbox = isPreDeleteRead
      ? overrides.preDeleteDefaultSandbox !== undefined
        ? overrides.preDeleteDefaultSandbox
        : (overrides.defaultSandbox ?? null)
      : (overrides.defaultSandbox ?? null);
    return {
      sandboxes: {
        alpha:
          isPreDeleteRead && overrides.preDeleteSandboxEntry
            ? overrides.preDeleteSandboxEntry
            : sandboxEntry,
      },
      defaultSandbox,
    };
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  const registryUpdateSpy = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
  const restoreSandboxEntrySpy = vi
    .spyOn(registry, "restoreSandboxEntry")
    .mockImplementation(() => undefined);
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: false,
    sessions: [],
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
    expectedVersion: "0.2.0",
    sandboxVersion: "0.1.0",
  });
  vi.spyOn(rebuildShields, "openRebuildShieldsWindow").mockReturnValue(rebuildShieldsWindow);
  const relockSpy = vi
    .spyOn(rebuildShields, "relockRebuildShieldsWindow")
    .mockImplementation((...args: unknown[]) => {
      const window = args[1] as typeof rebuildShieldsWindow;
      window.relocked = true;
      return true;
    });
  const backupSandboxStateSpy = vi.spyOn(sandboxState, "backupSandboxState").mockReturnValue({
    success: true,
    backedUpDirs: ["workspace"],
    backedUpFiles: ["user.md"],
    failedDirs: [],
    failedFiles: [],
    manifest: {
      backupPath: "/tmp/nemoclaw-rebuild-backup",
      timestamp: "2026-06-01T00:00:00.000Z",
      policyPresets: overrides.backupPolicyPresets ?? ["npm", "bad", "throw"],
    },
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
  const restoreSandboxStateSpy = vi.spyOn(sandboxState, "restoreSandboxState").mockImplementation(
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
  const removeSandboxRegistryEntrySpy = vi
    .spyOn(destroy, "removeSandboxRegistryEntry")
    .mockImplementation(overrides.removeSandboxRegistryEntry ?? (() => undefined));
  vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined);
  vi.spyOn(nim, "stopNimContainerByName").mockImplementation(() => undefined);
  const onboardSpy = vi.spyOn(onboardMod, "onboard").mockImplementation(async () => {
    await overrides.onboard?.(session);
  });
  vi.spyOn(onboardMod, "preflightAuthoritativeRebuildTarget").mockResolvedValue(undefined);
  const ensureValidatedBraveSearchCredentialSpy = vi
    .spyOn(onboardMod, "ensureValidatedWebSearchCredential")
    .mockImplementation(
      overrides.ensureValidatedWebSearchCredential ??
        overrides.ensureValidatedBraveSearchCredential ??
        (async () => "web-search-key"),
    );
  const applyPresetSpy = vi
    .spyOn(policies, "applyPreset")
    .mockImplementation((_sandboxName: unknown, presetName: unknown) => {
      const normalizedPresetName = String(presetName);
      if (overrides.applyPreset) return overrides.applyPreset(normalizedPresetName);
      if (normalizedPresetName === "throw") throw new Error("preset boom");
      return normalizedPresetName === "npm";
    });
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
    ensureTargetGatewaySpy,
    ensureValidatedBraveSearchCredentialSpy,
    logSpy,
    markStepFailedSpy,
    onboardSpy,
    registryUpdateSpy,
    releaseOnboardLockSpy,
    relockSpy,
    restoreSandboxStateSpy,
    runOpenshellSpy,
    messagingRebuildPlanSpy,
    prepareMcpBridgesForAbsentSandboxRebuildSpy,
    prepareMcpBridgesForRebuildSpy,
    reattachMcpProvidersAfterRebuildAbortSpy,
    removeSandboxRegistryEntrySpy,
    restoreSandboxEntrySpy,
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
    if (originalSandboxName === undefined) {
      delete process.env.NEMOCLAW_SANDBOX_NAME;
    } else {
      process.env.NEMOCLAW_SANDBOX_NAME = originalSandboxName;
    }
  });
}
