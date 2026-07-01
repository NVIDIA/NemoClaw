// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { makeActiveTeamsMessagingPlan } from "./rebuild-flow-test-fixtures";

type RebuildSandbox = typeof import("./rebuild")["rebuildSandbox"];
const requireDist = createRequire(import.meta.url);
const rebuildModulePath = "./rebuild.js";
requireDist(rebuildModulePath);
delete require.cache[requireDist.resolve(rebuildModulePath)];
type RebuildFlowStep = {
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};
type RebuildFlowSession = Record<string, unknown> & {
  lastStepStarted: string | null;
  status: string;
  failure: { step: string; message: string | null; recordedAt: string } | null;
  machine: {
    version: number;
    state: string;
    stateEnteredAt: string;
    revision: number;
  };
  steps: Record<string, RebuildFlowStep>;
};
type RebuildFlowOverrides = {
  applyPreset?: (presetName: string) => boolean;
  baseImagePreflight?: {
    ok: boolean;
    imageRef: string | null;
    overrideEnvVar: string | null;
  };
  executeSandboxCommand?: () => { status: number; stdout: string; stderr: string } | null;
  onboard?: (session: RebuildFlowSession) => Promise<void> | void;
  repairMutableConfigPerms?: () =>
    | { applied: false; skipReason: "agent" | "locked" | "unreadable"; reason: string }
    | { applied: true; verified: boolean; errors: string[] };
  restoreSandboxState?: () => {
    success: boolean;
    restoredDirs: string[];
    restoredFiles: string[];
    failedDirs: string[];
    failedFiles: string[];
  };
  restoreMcpBridgesAfterRebuild?: () => Promise<void>;
  buildMessagingRebuildPlan?: () => Promise<unknown> | unknown;
  sandboxEntry?: Record<string, unknown>;
  sessionSandboxName?: string;
  defaultSandbox?: string | null;
  staleRecovery?: boolean;
  mcpPreparation?: {
    entries: Array<Record<string, unknown>>;
    detachedProviderEntries: Array<Record<string, unknown>>;
    scrubbedAdapterEntries?: Array<Record<string, unknown>>;
  };
  runOpenshell?: (args: string[]) => {
    status: number;
    output: string;
    stdout?: string;
    stderr?: string;
  };
  backupPolicyPresets?: string[];
  ensureValidatedBraveSearchCredential?: () => Promise<unknown>;
  hermesCredentialKeys?: string[] | null;
  hermesProviderExists?: boolean;
  customImagePreflight?: { ok: true; imageTag: string | null } | { ok: false; detail: string };
  removeSandboxRegistryEntry?: () => void;
  clearShieldsState?: () => void;
};
type RebuildFlowHarness = {
  rebuildSandbox: RebuildSandbox;
  applyPresetSpy: MockInstance;
  backupSandboxStateSpy: MockInstance;
  errorSpy: MockInstance;
  executeSandboxCommandSpy: MockInstance;
  ensureMessagingHostForwardAfterRebuildSpy: MockInstance;
  ensureTargetGatewaySpy: MockInstance;
  ensureValidatedBraveSearchCredentialSpy: MockInstance;
  logSpy: MockInstance;
  markStepFailedSpy: MockInstance;
  onboardSpy: MockInstance;
  registryUpdateSpy: MockInstance;
  releaseOnboardLockSpy: MockInstance;
  relockSpy: MockInstance;
  restoreSandboxStateSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  messagingRebuildPlanSpy: MockInstance;
  prepareMcpBridgesForAbsentSandboxRebuildSpy: MockInstance;
  prepareMcpBridgesForRebuildSpy: MockInstance;
  reattachMcpProvidersAfterRebuildAbortSpy: MockInstance;
  removeSandboxRegistryEntrySpy: MockInstance;
  restoreSandboxEntrySpy: MockInstance;
  restoreMcpBridgesAfterRebuildSpy: MockInstance;
  warnUnpreservedUserManagedFilesSpy: MockInstance;
  session: RebuildFlowSession;
};
const originalSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
function snapshotEnv(names: readonly string[]): () => void {
  const saved = names.map((name) => [name, process.env[name]] as const);
  return () => {
    for (const [name] of saved) {
      delete process.env[name];
    }
    Object.assign(
      process.env,
      Object.fromEntries(
        saved.filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    );
  };
}
function createStep(status: string): RebuildFlowStep {
  return { status, startedAt: null, completedAt: null, error: null };
}
function createRebuildFlowSession(machineSnapshotVersion: number): RebuildFlowSession {
  return {
    sandboxName: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    credentialEnv: null,
    metadata: {},
    hermesToolGateways: [],
    lastStepStarted: null,
    status: "in_progress",
    failure: null,
    machine: {
      version: machineSnapshotVersion,
      state: "gateway",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 2,
    },
    steps: {
      preflight: createStep("complete"),
      gateway: createStep("complete"),
      provider_selection: createStep("pending"),
      inference: createStep("pending"),
      sandbox: createStep("pending"),
      openclaw: createStep("pending"),
      agent_setup: createStep("pending"),
      policies: createStep("pending"),
    },
  };
}
function installTerminalStepFailureMock(
  onboardSession: { markStepFailed: (...args: unknown[]) => unknown },
  session: RebuildFlowSession,
): MockInstance {
  return vi
    .spyOn(onboardSession, "markStepFailed")
    .mockImplementation((stepName: unknown, message: unknown, options: unknown) => {
      const stepKey = String(stepName);
      const step = session.steps[stepKey] ?? createStep("pending");
      session.steps[stepKey] = step;
      step.status = "failed";
      step.error = typeof message === "string" ? message : null;
      session.status = "failed";
      session.failure = {
        step: stepKey,
        message: typeof message === "string" ? message : null,
        recordedAt: "2026-06-01T00:02:00.000Z",
      };
      const updateMachine =
        (options as { updateMachine?: boolean } | undefined)?.updateMachine === true;
      session.machine.state = updateMachine ? "failed" : session.machine.state;
      session.machine.revision += updateMachine ? 1 : 0;
      return session;
    });
}

function createRebuildFlowHarness(overrides: RebuildFlowOverrides = {}): RebuildFlowHarness {
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
    result: { status: 0, output: overrides.staleRecovery ? "" : "alpha Ready" },
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
    nimContainer: null,
    nemoclawVersion: "0.1.0",
    dashboardPort: 18789,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    ...(overrides.sandboxEntry ?? {}),
  };
  vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry);
  vi.spyOn(registry, "getDefault").mockReturnValue(overrides.defaultSandbox ?? null);
  vi.spyOn(registry, "load").mockReturnValue({
    sandboxes: { alpha: sandboxEntry },
    defaultSandbox: overrides.defaultSandbox ?? null,
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
    .spyOn(onboardMod, "ensureValidatedBraveSearchCredential")
    .mockImplementation(
      overrides.ensureValidatedBraveSearchCredential ?? (async () => "brave-key"),
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
describe("rebuildSandbox flow", () => {
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
  it("backs up, recreates, restores, reapplies policy, and relocks on a successful OpenClaw rebuild", async () => {
    const mcpEntry = {
      server: "github",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "nemoclaw-mcp-alpha-github",
      policyName: "mcp-bridge-github",
      adapter: "mcporter",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    };
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxEntry: { policyPresetsFinalized: true, policyTier: "balanced" },
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).toHaveBeenCalledWith("alpha");
    expect(harness.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledWith("alpha");
    expect(harness.prepareMcpBridgesForRebuildSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.warnUnpreservedUserManagedFilesSpy.mock.invocationCallOrder[0],
    );
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: true,
        nonInteractive: true,
        recreateSandbox: true,
        authoritativeResumeConfig: true,
        autoYes: true,
      }),
    );
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "ollama-local",
        model: "nvidia/nemotron",
        webSearchEnabled: false,
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
    );
    const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
      (call) => Array.isArray(call[0]) && call[0].join(" ") === "sandbox delete alpha",
    );
    expect(harness.registryUpdateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall],
    );
    expect(harness.session.policyPresets).toEqual(["npm", "bad", "throw"]);
    expect(harness.session.steps.gateway.status).toBe("complete");
    expect(harness.session.steps.preflight.status).toBe("complete");
    expect(harness.session.steps.sandbox.status).toBe("pending");
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      "/tmp/nemoclaw-rebuild-backup",
    );
    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Preserving MCP-bearing registry entry across sandbox recreation",
    );
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "npm");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "bad");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "throw");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm", "bad", "throw"],
      policyTier: "balanced",
      policyPresetsFinalized: true,
    });
    expect(harness.executeSandboxCommandSpy).toHaveBeenCalledWith("alpha", "openclaw doctor --fix");
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe(originalSandboxName);
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "rebuilt successfully",
    );
  });

  it("relocks as absent when registry cleanup throws after confirmed delete", async () => {
    const harness = createRebuildFlowHarness({
      removeSandboxRegistryEntry: () => {
        throw new Error("registry cleanup after delete failed");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("registry cleanup after delete failed");

    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenLastCalledWith(
      "alpha",
      expect.any(Object),
      false,
      "nemoclaw",
    );
  });

  it("relocks as present when shields postwork throws after successful onboard", async () => {
    const harness = createRebuildFlowHarness({
      staleRecovery: true,
      clearShieldsState: () => {
        throw new Error("post-onboard shields cleanup failed");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("post-onboard shields cleanup failed");

    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(harness.relockSpy).toHaveBeenLastCalledWith(
      "alpha",
      expect.any(Object),
      true,
      "nemoclaw",
    );
  });

  it("uses the no-exec MCP preparation path when recovering an absent sandbox", async () => {
    const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
    const restoreEnv = snapshotEnv([overrideEnvVar]);
    process.env[overrideEnvVar] = "nemoclaw-hermes-sandbox-base-local:image-caller";
    const mcpEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      policyName: "mcp-bridge-github",
      addedAt: "2026-06-01T00:00:00.000Z",
    };
    try {
      const harness = createRebuildFlowHarness({
        staleRecovery: true,
        sandboxEntry: { mcp: { bridges: { github: mcpEntry } } },
        baseImagePreflight: {
          ok: true,
          imageRef: "nemoclaw-hermes-sandbox-base-local:image-preflighted",
          overrideEnvVar,
        },
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [],
          scrubbedAdapterEntries: [],
        },
        onboard: () => {
          expect(process.env[overrideEnvVar]).toBe(
            "nemoclaw-hermes-sandbox-base-local:image-preflighted",
          );
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(process.env[overrideEnvVar]).toBe("nemoclaw-hermes-sandbox-base-local:image-caller");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.prepareMcpBridgesForAbsentSandboxRebuildSpy).toHaveBeenCalledWith("alpha");
      expect(harness.prepareMcpBridgesForRebuildSpy).not.toHaveBeenCalled();
      expect(harness.warnUnpreservedUserManagedFilesSpy).not.toHaveBeenCalled();
      expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).not.toHaveBeenCalled();
      expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
    } finally {
      restoreEnv();
    }
  });

  it("pins compatible-endpoint reasoning for an MCP-bearing rebuild", async () => {
    const restoreEnv = snapshotEnv(["COMPATIBLE_API_KEY", "NEMOCLAW_REASONING"]);
    process.env.COMPATIBLE_API_KEY = "compat-key";
    process.env.NEMOCLAW_REASONING = "false";
    const mcpEntry = {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github",
      policyName: "mcp-bridge-github",
      addedAt: "2026-06-01T00:00:00.000Z",
    };
    let reasoningSeenInsideOnboard: string | undefined;
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: {
          provider: "compatible-endpoint",
          model: "reasoning-model",
          endpointUrl: "https://compatible.example.test/v1",
          compatibleEndpointReasoning: "true",
          mcp: { bridges: { github: mcpEntry } },
        },
        sessionSandboxName: "other",
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
        },
        onboard: (session) => {
          reasoningSeenInsideOnboard = process.env.NEMOCLAW_REASONING;
          expect(session.compatibleEndpointReasoning).toBe("true");
        },
      });
      harness.session.compatibleEndpointReasoning = "false";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(reasoningSeenInsideOnboard).toBeUndefined();
      expect(harness.session.compatibleEndpointReasoning).toBe("true");
      expect(process.env.NEMOCLAW_REASONING).toBe("false");
      expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
    } finally {
      restoreEnv();
    }
  });

  it("restores enabled messaging presets while pruning disabled ones from final policies", async () => {
    const disabledSlackPlan = {
      schemaVersion: 1,
      sandboxName: "alpha",
      agent: "openclaw",
      workflow: "rebuild",
      channels: [
        { channelId: "telegram", disabled: false },
        { channelId: "discord", disabled: false },
        { channelId: "whatsapp", disabled: false },
        { channelId: "wechat", disabled: false },
        { channelId: "slack", disabled: true },
      ],
      disabledChannels: ["slack"],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      backupPolicyPresets: ["slack", "npm", "pypi", "telegram"],
      buildMessagingRebuildPlan: () => disabledSlackPlan,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.applyPresetSpy.mock.calls.map((call) => call[1])).toEqual([
      "npm",
      "pypi",
      "telegram",
      "discord",
      "whatsapp",
      "wechat",
    ]);
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm", "pypi", "telegram", "discord", "whatsapp", "wechat"],
      policyTier: null,
      policyPresetsFinalized: undefined,
    });
  });

  it("preserves a finalized empty policy selection and its tier", async () => {
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      backupPolicyPresets: [],
      sandboxEntry: {
        policies: [],
        policyPresetsFinalized: true,
        policyTier: "restricted",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.session.policyPresets).toEqual([]);
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: [],
      policyTier: "restricted",
      policyPresetsFinalized: true,
    });
  });

  it("prunes the disabled Teams preset from the final registry policies after rebuild", async () => {
    const disabledTeamsPlan = {
      schemaVersion: 1,
      sandboxName: "alpha",
      agent: "openclaw",
      workflow: "rebuild",
      channels: [],
      disabledChannels: ["teams"],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      backupPolicyPresets: ["teams", "npm"],
      buildMessagingRebuildPlan: () => disabledTeamsPlan,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "npm");
    expect(harness.applyPresetSpy).not.toHaveBeenCalledWith("alpha", "teams");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm"],
      policyTier: null,
      policyPresetsFinalized: undefined,
    });
  });

  it("aborts before backup/delete when messaging manifest staging fails", async () => {
    const harness = createRebuildFlowHarness({
      buildMessagingRebuildPlan: () => {
        throw new Error("manifest boom");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("manifest boom");

    const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("messaging manifest plan could not be staged");
    expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("reattaches exactly the MCP providers detached when sandbox deletion fails", async () => {
    const attached = {
      server: "attached",
      providerName: "nemoclaw-mcp-alpha-attached",
    };
    const alreadyDetached = {
      server: "already-detached",
      providerName: "nemoclaw-mcp-alpha-already-detached",
    };
    const harness = createRebuildFlowHarness({
      mcpPreparation: {
        entries: [attached, alreadyDetached],
        detachedProviderEntries: [attached],
      },
      runOpenshell: (args) =>
        args.join(" ") === "sandbox delete alpha"
          ? { status: 7, output: "delete failed", stderr: "delete failed" }
          : { status: 0, output: "" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Failed to delete sandbox");

    expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledWith(
      "alpha",
      [attached],
      undefined,
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("does not reclaim the default sandbox when an MCP rebuild recreate fails", async () => {
    const mcpEntry = {
      server: "github",
      providerName: "nemoclaw-mcp-alpha-github",
    };
    const harness = createRebuildFlowHarness({
      defaultSandbox: "alpha",
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
      },
      onboard: () => {
        throw new Error("inner recreate boom");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntrySpy.mock.calls).toEqual([
      [expect.objectContaining({ name: "alpha" })],
    ]);
  });

  it("starts the active Teams host forward after a successful rebuild", async () => {
    const plan = makeActiveTeamsMessagingPlan();
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      buildMessagingRebuildPlan: () => plan,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.ensureMessagingHostForwardAfterRebuildSpy).toHaveBeenCalledWith("alpha", plan);
    expect(
      harness.ensureMessagingHostForwardAfterRebuildSpy.mock.invocationCallOrder[0],
    ).toBeGreaterThan(harness.onboardSpy.mock.invocationCallOrder[0]);
  });

  it("finishes the rebuild while surfacing incomplete post-restore work", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { policyPresetsFinalized: true, policyTier: "balanced" },
      executeSandboxCommand: () => ({ status: 1, stdout: "", stderr: "hash refresh failed" }),
      repairMutableConfigPerms: () => ({
        applied: false,
        skipReason: "unreadable",
        reason: "cannot stat mutable config",
      }),
      restoreSandboxState: () => ({
        success: false,
        restoredDirs: ["workspace"],
        restoredFiles: [],
        failedDirs: ["config"],
        failedFiles: ["user.md"],
      }),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).toContain("State restore was incomplete");
    expect(output).toContain("Mutable config permissions were not verified");
    expect(output).toContain("Mutable OpenClaw config hash was not refreshed");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "bad");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "throw");
    expect(harness.errorSpy).toHaveBeenCalledWith(expect.stringContaining("bad, throw"));
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm"],
      policyTier: "balanced",
      policyPresetsFinalized: undefined,
    });
    expect(output).toContain("Policy presets failed to reapply: bad, throw");
  });

  it("reports both MCP and policy recovery when both restores are incomplete", async () => {
    const mcpEntry = {
      server: "github",
      providerName: "nemoclaw-mcp-alpha-github",
    };
    const harness = createRebuildFlowHarness({
      applyPreset: () => false,
      backupPolicyPresets: ["npm"],
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
      },
      restoreMcpBridgesAfterRebuild: () => Promise.reject(new Error("MCP restore boom")),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).toContain("Policy presets failed to reapply: npm");
    expect(output).not.toContain("rebuilt successfully");
    expect(harness.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("MCP bridge restore incomplete: MCP restore boom"),
    );
  });

  it("isolates ambient onboard-selection env during recreate, then restores it (#5735)", async () => {
    const restoreEnv = snapshotEnv([
      "NEMOCLAW_AGENT",
      "NEMOCLAW_PROVIDER_KEY",
      "NVIDIA_INFERENCE_API_KEY",
    ]);
    process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
    process.env.NEMOCLAW_PROVIDER_KEY = "sk-bogus-installer-key";
    process.env.NVIDIA_INFERENCE_API_KEY = "hosted-source-key";

    let envSeenInsideOnboard: {
      agent: string | undefined;
      providerKey: string | undefined;
      hostedSourceKey: string | undefined;
    } | null = null;

    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        onboard: () => {
          envSeenInsideOnboard = {
            agent: process.env.NEMOCLAW_AGENT,
            providerKey: process.env.NEMOCLAW_PROVIDER_KEY,
            hostedSourceKey: process.env.NVIDIA_INFERENCE_API_KEY,
          };
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(envSeenInsideOnboard).toEqual({
        agent: undefined,
        providerKey: undefined,
        hostedSourceKey: "hosted-source-key",
      });
      const logged = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("Ignoring ambient NEMOCLAW_AGENT='langchain-deepagents-code'");
      expect(process.env.NEMOCLAW_AGENT).toBe("langchain-deepagents-code");
      expect(process.env.NEMOCLAW_PROVIDER_KEY).toBe("sk-bogus-installer-key");
      expect(process.env.NVIDIA_INFERENCE_API_KEY).toBe("hosted-source-key");
    } finally {
      restoreEnv();
    }
  });

  it("uses the exact preflighted agent base image only for the recreate", async () => {
    const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
    const restoreEnv = snapshotEnv([overrideEnvVar]);
    delete process.env[overrideEnvVar];
    let refSeenInsideOnboard: string | undefined;

    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { agent: "hermes" },
        baseImagePreflight: {
          ok: true,
          imageRef: "nemoclaw-hermes-sandbox-base-local:12345678",
          overrideEnvVar,
        },
        onboard: () => {
          refSeenInsideOnboard = process.env[overrideEnvVar];
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(refSeenInsideOnboard).toBe("nemoclaw-hermes-sandbox-base-local:12345678");
      expect(process.env[overrideEnvVar]).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it("restores caller messaging config and plan env after rebuild", async () => {
    const keys = ["NEMOCLAW_MESSAGING_PLAN_B64", "TELEGRAM_REQUIRE_MENTION"];
    const restoreEnv = snapshotEnv(keys);
    process.env.NEMOCLAW_MESSAGING_PLAN_B64 = "caller-plan";
    delete process.env.TELEGRAM_REQUIRE_MENTION;
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        onboard: () => {
          process.env.NEMOCLAW_MESSAGING_PLAN_B64 = "target-plan";
          process.env.TELEGRAM_REQUIRE_MENTION = "1";
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(process.env.NEMOCLAW_MESSAGING_PLAN_B64).toBe("caller-plan");
      expect(process.env.TELEGRAM_REQUIRE_MENTION).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it("recreates a matching-session custom-endpoint sandbox from a validated session endpoint while ignoring hostile ambient values for PRA-4 (#5735)", async () => {
    const restoreEnv = snapshotEnv([
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_MODEL",
      "COMPATIBLE_API_KEY",
    ]);
    process.env.NEMOCLAW_ENDPOINT_URL = "https://attacker.example.test/v1";
    process.env.NEMOCLAW_PROVIDER = "build";
    process.env.NEMOCLAW_MODEL = "attacker-model";
    process.env.COMPATIBLE_API_KEY = "compat-key"; // pass credential preflight

    let envSeenInsideOnboard: Record<string, string | undefined> | null = null;
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: { provider: "compatible-endpoint", model: "session-model" },
        onboard: () => {
          envSeenInsideOnboard = {
            endpoint: process.env.NEMOCLAW_ENDPOINT_URL,
            provider: process.env.NEMOCLAW_PROVIDER,
            model: process.env.NEMOCLAW_MODEL,
          };
        },
      });
      harness.session.provider = "compatible-endpoint";
      harness.session.model = "session-model";
      harness.session.endpointUrl = "https://my-custom-endpoint.example/v1?x=1#frag";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(envSeenInsideOnboard).toEqual({
        endpoint: undefined,
        provider: undefined,
        model: undefined,
      });
      expect(harness.session.endpointUrl).toBe("https://my-custom-endpoint.example/v1");
      expect(harness.session.provider).toBe("compatible-endpoint");
      expect(harness.session.model).toBe("session-model");
      expect(process.env.NEMOCLAW_ENDPOINT_URL).toBe("https://attacker.example.test/v1");
      expect(process.env.NEMOCLAW_PROVIDER).toBe("build");
      expect(process.env.NEMOCLAW_MODEL).toBe("attacker-model");
    } finally {
      restoreEnv();
    }
  });

  it("aborts before backup/delete when a custom-endpoint target has no matching session (#5735)", async () => {
    const restoreEnv = snapshotEnv(["COMPATIBLE_API_KEY"]);
    process.env.COMPATIBLE_API_KEY = "compat-key"; // pass credential preflight first
    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { provider: "compatible-endpoint", model: "custom-model" },
        sessionSandboxName: "some-other-sandbox",
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Cannot determine recreate endpoint");

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("cannot determine the inference endpoint");
      expect(errors).toContain("Sandbox is untouched");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("aborts before backup/delete when durable Brave credential validation fails", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { webSearchEnabled: true },
      sessionSandboxName: "some-other-sandbox",
      ensureValidatedBraveSearchCredential: async () => {
        throw new Error("invalid Brave credential");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Brave Web Search credential preflight failed");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("rejects recorded web search when the target agent does not support it", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { agent: "hermes", webSearchEnabled: true },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded Brave Web Search is unsupported");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("preserves legacy Brave web search during a nonmatching-session rebuild", async () => {
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxEntry: { policies: ["brave"], webSearchEnabled: undefined },
      sessionSandboxName: "some-other-sandbox",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.ensureValidatedBraveSearchCredentialSpy).toHaveBeenCalledWith(true);
    expect(harness.session.webSearchConfig).toEqual({ fetchEnabled: true });
  });

  it("recreates unrelated-session targets from durable web, image, and Hermes auth state", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-from-"));
    const dockerfile = path.join(tempDir, "Dockerfile.custom");
    fs.writeFileSync(dockerfile, "FROM scratch\nARG NEMOCLAW_WEB_SEARCH_ENABLED=0\n");
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sessionSandboxName: "some-other-sandbox",
      sandboxEntry: {
        provider: "hermes-provider",
        model: "hermes-model",
        webSearchEnabled: true,
        fromDockerfile: dockerfile,
        hermesAuthMethod: "api_key",
      },
      hermesCredentialKeys: ["NOUS_API_KEY"],
    });
    harness.session.webSearchConfig = null;
    harness.session.hermesAuthMethod = "oauth";
    harness.session.metadata = { fromDockerfile: "/tmp/unrelated.Dockerfile" };

    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.ensureValidatedBraveSearchCredentialSpy).toHaveBeenCalledWith(true);
      expect(harness.session.webSearchConfig).toEqual({ fetchEnabled: true });
      expect(harness.session.hermesAuthMethod).toBe("api_key");
      expect(harness.session.credentialEnv).toBe("NOUS_API_KEY");
      expect(harness.session.metadata).toMatchObject({ fromDockerfile: dockerfile });
      expect(harness.onboardSpy).toHaveBeenCalledWith(
        expect.objectContaining({ fromDockerfile: dockerfile }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the Hermes OAuth credential binding with durable OAuth auth", async () => {
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxEntry: {
        agent: "hermes",
        provider: "hermes-provider",
        model: "hermes-model",
        hermesAuthMethod: "oauth",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.session.hermesAuthMethod).toBe("oauth");
    expect(harness.session.credentialEnv).toBe("OPENAI_API_KEY");
  });

  it("rejects a shared Hermes Provider whose credential binding changed", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        provider: "hermes-provider",
        model: "hermes-model",
        hermesAuthMethod: "api_key",
      },
      hermesCredentialKeys: ["OPENAI_API_KEY"],
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Missing Hermes Provider credentials");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  });

  it("does not use a generic provider alias to recreate a missing Hermes API-key binding", async () => {
    const restoreEnv = snapshotEnv(["NOUS_API_KEY", "NEMOCLAW_PROVIDER_KEY"]);
    delete process.env.NOUS_API_KEY;
    process.env.NEMOCLAW_PROVIDER_KEY = "unrelated-provider-key";
    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          provider: "hermes-provider",
          model: "hermes-model",
          hermesAuthMethod: "api_key",
        },
        hermesProviderExists: false,
      });
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Missing Hermes Provider credentials");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it("ignores a stale matching-session credential for a resolved local target", async () => {
    const harness = createRebuildFlowHarness();
    harness.session.credentialEnv = "NVIDIA_INFERENCE_API_KEY";

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.session.credentialEnv).toBeNull();
  });

  it("fails closed when a legacy matching session recovers Hermes without auth state", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { provider: null, model: null, hermesAuthMethod: undefined },
    });
    harness.session.provider = "hermes-provider";
    harness.session.model = "hermes-model";
    harness.session.hermesAuthMethod = null;

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Cannot determine recorded Hermes Provider authentication method");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("treats durable web-search false and Dockerfile null as authoritative", async () => {
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxEntry: {
        webSearchEnabled: false,
        fromDockerfile: null,
        hermesAuthMethod: null,
      },
    });
    harness.session.webSearchConfig = { fetchEnabled: true };
    harness.session.hermesAuthMethod = "oauth";
    harness.session.metadata = { fromDockerfile: "/tmp/stale.Dockerfile" };

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.ensureValidatedBraveSearchCredentialSpy).not.toHaveBeenCalled();
    expect(harness.session.webSearchConfig).toBeNull();
    expect(harness.session.hermesAuthMethod).toBeNull();
    expect(harness.session.metadata).toMatchObject({ fromDockerfile: null });
  });

  it("aborts before backup/delete when the durable custom Dockerfile is missing", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { fromDockerfile: "/definitely/missing/NemoClaw.Dockerfile" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded custom Dockerfile is unavailable");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("aborts before backup/delete when the durable custom Dockerfile is unreadable", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-from-"));
    const dockerfile = path.join(tempDir, "Dockerfile.unreadable");
    fs.writeFileSync(dockerfile, "FROM scratch\n", { mode: 0o000 });
    const harness = createRebuildFlowHarness({ sandboxEntry: { fromDockerfile: dockerfile } });
    try {
      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Recorded custom Dockerfile is unavailable");
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed on a corrupt durable custom Dockerfile value", async () => {
    const harness = createRebuildFlowHarness({ sandboxEntry: { fromDockerfile: 42 } });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded custom Dockerfile is invalid");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("rebuilds a known-remote target even when the session belongs to another sandbox (#5735)", async () => {
    const restoreEnv = snapshotEnv(["NVIDIA_INFERENCE_API_KEY"]);
    process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-key"; // pass credential preflight
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: { provider: "nvidia-prod", model: "nvidia/nemotron" },
        sessionSandboxName: "some-other-sandbox",
      });
      const staleEndpoint = "https://stale.example.test/v1";
      harness.session.endpointUrl = staleEndpoint;
      harness.session.metadata = {
        gatewayName: "nemoclaw",
        fromDockerfile: "/tmp/unrelated.Dockerfile",
      };
      harness.session.webSearchConfig = { fetchEnabled: true };
      harness.session.policyPresets = ["foreign-preset"];
      harness.session.gpuPassthrough = true;

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.onboardSpy).toHaveBeenCalled();
      const providerPreflightCall = harness.runOpenshellSpy.mock.calls.findIndex(
        ([args]) => Array.isArray(args) && args[0] === "provider",
      );
      expect(providerPreflightCall).toBeGreaterThanOrEqual(0);
      expect(harness.ensureTargetGatewaySpy.mock.invocationCallOrder[0]).toBeLessThan(
        harness.runOpenshellSpy.mock.invocationCallOrder[providerPreflightCall],
      );
      expect(harness.session.endpointUrl).not.toBe(staleEndpoint);
      expect(harness.session.metadata).toMatchObject({ fromDockerfile: null });
      expect(harness.session.webSearchConfig).toBeNull();
      expect(harness.session.policyPresets).toEqual(["npm", "bad", "throw"]);
      expect(harness.session.gpuPassthrough).toBe(false);
      expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
    } finally {
      restoreEnv();
    }
  });

  it("does not abort a routed (nvidia-router) target with a non-matching session (#5735)", async () => {
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxEntry: { provider: "nvidia-router", model: "router-model" },
      sessionSandboxName: "some-other-sandbox",
    });
    harness.session.routerPid = 4242;
    harness.session.routerCredentialHash = "router-credential-hash";

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.onboardSpy).toHaveBeenCalled();
    expect(harness.session.routerPid).toBe(4242);
    expect(harness.session.routerCredentialHash).toBe("router-credential-hash");
  });

  it("marks recreate onboarding failures as terminal and preserves retry cleanup", async () => {
    const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
    const restoreEnv = snapshotEnv([overrideEnvVar]);
    process.env[overrideEnvVar] = "nemoclaw-hermes-sandbox-base-local:image-caller";
    try {
      const harness = createRebuildFlowHarness({
        baseImagePreflight: {
          ok: true,
          imageRef: "nemoclaw-hermes-sandbox-base-local:image-preflighted",
          overrideEnvVar,
        },
        onboard: (session) => {
          expect(process.env[overrideEnvVar]).toBe(
            "nemoclaw-hermes-sandbox-base-local:image-preflighted",
          );
          session.lastStepStarted = "sandbox";
          throw new Error("inner recreate boom");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Recreate failed");

      expect(process.env[overrideEnvVar]).toBe("nemoclaw-hermes-sandbox-base-local:image-caller");
      expect(harness.releaseOnboardLockSpy).toHaveBeenCalled();
      expect(harness.markStepFailedSpy).toHaveBeenCalledWith(
        "sandbox",
        "Rebuild recreate failed",
        expect.objectContaining({ updateMachine: true }),
      );
      expect(harness.session).toMatchObject({
        status: "failed",
        failure: { step: "sandbox", message: "Rebuild recreate failed" },
        machine: { state: "failed" },
        steps: { sandbox: { status: "failed", error: "Rebuild recreate failed" } },
      });
      expect(harness.relockSpy).toHaveBeenCalledWith(
        "alpha",
        expect.any(Object),
        false,
        "nemoclaw",
      );
      expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe(originalSandboxName);

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("Recreate failed after sandbox was destroyed");
      expect(errors).toContain("Backup is preserved at: /tmp/nemoclaw-rebuild-backup");
      expect(errors).toContain("onboard --resume");
    } finally {
      restoreEnv();
    }
  });
});
