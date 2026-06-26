// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type RebuildSandbox =
  typeof import("../../../../dist/lib/actions/sandbox/rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);
const rebuildModulePath = "../../../../dist/lib/actions/sandbox/rebuild.js";

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
  buildMessagingRebuildPlan?: () => Promise<unknown> | unknown;
  sandboxEntry?: Record<string, unknown>;
  sessionSandboxName?: string;
};

type RebuildFlowHarness = {
  rebuildSandbox: RebuildSandbox;
  applyPresetSpy: MockInstance;
  backupSandboxStateSpy: MockInstance;
  errorSpy: MockInstance;
  executeSandboxCommandSpy: MockInstance;
  ensureMessagingHostForwardAfterRebuildSpy: MockInstance;
  logSpy: MockInstance;
  markStepFailedSpy: MockInstance;
  onboardSpy: MockInstance;
  registryUpdateSpy: MockInstance;
  releaseOnboardLockSpy: MockInstance;
  relockSpy: MockInstance;
  restoreSandboxStateSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  messagingRebuildPlanSpy: MockInstance;
  session: RebuildFlowSession;
};

const originalSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;

// Snapshot the given env vars and return a restore fn that reinstates their
// prior values exactly — vars that were unset stay unset, set ones are put back.
// Branchless on purpose (filter, not conditional restore) so it both restores
// worker state correctly and keeps the changed-test-file guardrail green.
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

  const gatewayDrift = requireDist("../../../../dist/lib/adapters/openshell/gateway-drift.js");
  const openshellRuntime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
  const sandboxList = requireDist("../../../../dist/lib/openshell-sandbox-list.js");
  const resolve = requireDist("../../../../dist/lib/adapters/openshell/resolve.js");
  const agentDefs = requireDist("../../../../dist/lib/agent/defs.js");
  const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");
  const onboardMod = requireDist("../../../../dist/lib/onboard.js");
  const onboardSession = requireDist("../../../../dist/lib/state/onboard-session.js");
  const registry = requireDist("../../../../dist/lib/state/registry.js");
  const sandboxState = requireDist("../../../../dist/lib/state/sandbox.js");
  const sandboxSession = requireDist("../../../../dist/lib/state/sandbox-session.js");
  const sandboxVersion = requireDist("../../../../dist/lib/sandbox/version.js");
  const destroy = requireDist("../../../../dist/lib/actions/sandbox/destroy.js");
  const rebuildShields = requireDist("../../../../dist/lib/actions/sandbox/rebuild-shields.js");
  const nim = requireDist("../../../../dist/lib/inference/nim.js");
  const policies = requireDist("../../../../dist/lib/policy/index.js");
  const processRecovery = requireDist("../../../../dist/lib/actions/sandbox/process-recovery.js");
  const messagingHostForwardLifecycle = requireDist(
    "../../../../dist/lib/actions/sandbox/messaging-host-forward-lifecycle.js",
  );
  const messaging = requireDist("../../../../dist/lib/messaging/index.js");
  const shields = requireDist("../../../../dist/lib/shields/index.js");

  const session = createRebuildFlowSession(onboardSession.MACHINE_SNAPSHOT_VERSION);
  const rebuildShieldsWindow = { relocked: false, wasLocked: false };
  const agentDef = {
    name: "openclaw",
    expectedVersion: "0.2.0",
  };

  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
    result: { status: 0, output: "alpha Ready" },
  });
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agentDef);
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "openclaw" });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
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
  const markStepFailedSpy = installTerminalStepFailureMock(onboardSession, session);
  session.sandboxName = overrides.sessionSandboxName ?? session.sandboxName;
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    policies: ["npm"],
    agent: null,
    nimContainer: null,
    ...(overrides.sandboxEntry ?? {}),
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  const registryUpdateSpy = vi.spyOn(registry, "updateSandbox").mockImplementation(() => undefined);
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
      policyPresets: ["npm", "bad", "throw"],
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
    .mockReturnValue({ status: 0, output: "" });
  vi.spyOn(destroy, "removeSandboxRegistryEntry").mockImplementation(() => undefined);
  vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined);
  vi.spyOn(nim, "stopNimContainerByName").mockImplementation(() => undefined);
  const onboardSpy = vi.spyOn(onboardMod, "onboard").mockImplementation(async () => {
    await overrides.onboard?.(session);
  });
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
  const messagingRebuildPlanSpy = vi
    .spyOn(messaging.MessagingWorkflowPlanner.prototype, "buildRebuildPlanFromSandboxEntry")
    .mockImplementation(overrides.buildMessagingRebuildPlan ?? (() => null));
  const ensureMessagingHostForwardAfterRebuildSpy = vi
    .spyOn(messagingHostForwardLifecycle, "ensureMessagingHostForwardAfterRebuild")
    .mockReturnValue(true);

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
    logSpy,
    markStepFailedSpy,
    onboardSpy,
    registryUpdateSpy,
    releaseOnboardLockSpy,
    relockSpy,
    restoreSandboxStateSpy,
    runOpenshellSpy,
    messagingRebuildPlanSpy,
    session,
  };
}

function makeActiveTeamsMessagingPlan() {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "rebuild",
    channels: [
      {
        channelId: "teams",
        displayName: "Microsoft Teams",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [
          {
            channelId: "teams",
            inputId: "appId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_APP_ID",
            statePath: "teamsConfig.appId",
            value: "teams-app-id",
          },
          {
            channelId: "teams",
            inputId: "clientSecret",
            kind: "secret",
            required: true,
            sourceEnv: "MSTEAMS_APP_PASSWORD",
            credentialAvailable: true,
          },
          {
            channelId: "teams",
            inputId: "tenantId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_TENANT_ID",
            statePath: "teamsConfig.tenantId",
            value: "teams-tenant-id",
          },
          {
            channelId: "teams",
            inputId: "webhookPort",
            kind: "config",
            required: false,
            sourceEnv: "MSTEAMS_PORT",
            statePath: "teamsConfig.webhookPort",
            value: "3978",
          },
        ],
        hostForward: {
          channelId: "teams",
          port: 3978,
          label: "Microsoft Teams webhook",
        },
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: ["teams"], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
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
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).toHaveBeenCalledWith("alpha");
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resume: true,
        nonInteractive: true,
        recreateSandbox: true,
        autoYes: true,
      }),
    );
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      "/tmp/nemoclaw-rebuild-backup",
    );
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "npm");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "bad");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "throw");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", { agentVersion: "0.2.0" });
    expect(harness.executeSandboxCommandSpy).toHaveBeenCalledWith("alpha", "openclaw doctor --fix");
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe("alpha");
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "rebuilt successfully",
    );
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
    expect(errors).toContain("Sandbox is untouched");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
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
  });

  it("isolates ambient onboard-selection env during recreate, then restores it (#5735)", async () => {
    // Simulate an installer that just onboarded an unrelated Deep Agents
    // sandbox and left its selection env in the process before
    // `upgrade-sandboxes --auto` rebuilds an existing OpenClaw (registry agent
    // null) sandbox.
    const restoreEnv = snapshotEnv(["NEMOCLAW_AGENT", "NEMOCLAW_PROVIDER_KEY"]);
    process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
    process.env.NEMOCLAW_PROVIDER_KEY = "sk-bogus-installer-key";

    let envSeenInsideOnboard: {
      agent: string | undefined;
      providerKey: string | undefined;
    } | null = null;

    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        onboard: () => {
          // onboard --resume's agent/provider/credential resolution reads these
          // directly from process.env; they must be gone during recreate so the
          // pinned registry session wins.
          envSeenInsideOnboard = {
            agent: process.env.NEMOCLAW_AGENT,
            providerKey: process.env.NEMOCLAW_PROVIDER_KEY,
          };
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(envSeenInsideOnboard).toEqual({ agent: undefined, providerKey: undefined });
      // The mismatch (env agent != registry agent) is surfaced before delete.
      const logged = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("Ignoring ambient NEMOCLAW_AGENT='langchain-deepagents-code'");
      // The caller's env is left exactly as it was after the rebuild.
      expect(process.env.NEMOCLAW_AGENT).toBe("langchain-deepagents-code");
      expect(process.env.NEMOCLAW_PROVIDER_KEY).toBe("sk-bogus-installer-key");
    } finally {
      restoreEnv();
    }
  });

  it("recreates a matching-session custom-endpoint sandbox from session, ignoring hostile ambient endpoint/provider/model (#5735 PRA-4)", async () => {
    // Matching session (sandboxName === target) with a custom endpoint recorded
    // in that session. Hostile ambient NEMOCLAW_ENDPOINT_URL/PROVIDER/MODEL must
    // be absent during recreate (so onboard --resume uses the session) and the
    // session's own recorded endpoint must be preserved (not overwritten).
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
      // The custom endpoint lives only in this sandbox's own (matching) session.
      harness.session.endpointUrl = "https://my-custom-endpoint.example/v1";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      // Ambient selection env was isolated during the recreate.
      expect(envSeenInsideOnboard).toEqual({
        endpoint: undefined,
        provider: undefined,
        model: undefined,
      });
      // The matching session's own recorded endpoint is preserved (not pinned/overwritten).
      expect(harness.session.endpointUrl).toBe("https://my-custom-endpoint.example/v1");
      // Provider/model come from the registry entry, not the ambient values.
      expect(harness.session.provider).toBe("compatible-endpoint");
      expect(harness.session.model).toBe("session-model");
      // Caller env restored afterward.
      expect(process.env.NEMOCLAW_ENDPOINT_URL).toBe("https://attacker.example.test/v1");
      expect(process.env.NEMOCLAW_PROVIDER).toBe("build");
      expect(process.env.NEMOCLAW_MODEL).toBe("attacker-model");
    } finally {
      restoreEnv();
    }
  });

  it("aborts before backup/delete when a custom-endpoint target has no matching session (#5735)", async () => {
    // Installer flow: the loaded onboard session belongs to a different
    // (just-created) sandbox, and the target uses a custom OpenAI-compatible
    // provider whose base URL is only in its own session. Recreating it would
    // either fail or reconfigure against the wrong endpoint after deletion — so
    // rebuild must fail closed with the sandbox intact.
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

  it("rebuilds a known-remote target even when the session belongs to another sandbox (#5735)", async () => {
    // The same non-matching-session scenario but with a provider that has a
    // canonical endpoint (NVIDIA Endpoints): the endpoint is re-derivable from
    // registry, so the rebuild proceeds (no abort) and pins it.
    const restoreEnv = snapshotEnv(["NVIDIA_INFERENCE_API_KEY"]);
    process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-key"; // pass credential preflight
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: { provider: "nvidia-prod", model: "nvidia/nemotron" },
        sessionSandboxName: "some-other-sandbox",
      });
      // A stale endpoint carried over from the unrelated session must be
      // repinned from the nvidia-prod canonical config, not reused as-is.
      const staleEndpoint = "https://stale.example.test/v1";
      harness.session.endpointUrl = staleEndpoint;

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.onboardSpy).toHaveBeenCalled();
      expect(harness.session.endpointUrl).not.toBe(staleEndpoint);
      expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
    } finally {
      restoreEnv();
    }
  });

  it("does not abort a routed (nvidia-router) target with a non-matching session (#5735)", async () => {
    // nvidia-router derives its endpoint from the blueprint, not the session, so
    // the endpoint preflight must not treat it like a custom endpoint and abort.
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxEntry: { provider: "nvidia-router", model: "router-model" },
      sessionSandboxName: "some-other-sandbox",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.onboardSpy).toHaveBeenCalled();
  });

  it("marks recreate onboarding failures as terminal and preserves retry cleanup", async () => {
    const harness = createRebuildFlowHarness({
      onboard: (session) => {
        session.lastStepStarted = "sandbox";
        throw new Error("inner recreate boom");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

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
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), false, "nemoclaw");
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe("alpha");

    // #5735 (PRA-T2): preconditions (credential/endpoint) passed, so the
    // delete proceeded; when onboard() then fails for a residual runtime reason,
    // the operator must get a clear fatal recovery path with the preserved
    // backup — not a silent loss. Precondition-class failures are caught before
    // delete by prepareRebuildResumeConfig (covered by the abort tests above).
    const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("Recreate failed after sandbox was destroyed");
    expect(errors).toContain("Backup is preserved at: /tmp/nemoclaw-rebuild-backup");
    expect(errors).toContain("onboard --resume");
  });
});
