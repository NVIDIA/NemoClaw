// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRebuildFlowHarness,
  makeActiveTeamsMessagingPlan,
  makePreparedRecoveryManifest,
  originalSandboxName,
  rebuildModulePath,
  requireDist,
  snapshotEnv,
} from "./rebuild-flow.test-support";

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
      sandboxEntry: { resourceCpu: "4", resourceMemory: "8Gi" },
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
        authoritativeResourceProfile: { cpu: "4", memory: "8Gi" },
      }),
    );
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      "/tmp/nemoclaw-rebuild-backup",
    );
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "npm");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "bad");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "throw");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm", "bad", "throw"],
    });
    expect(harness.executeSandboxCommandSpy).toHaveBeenCalledWith("alpha", "openclaw doctor --fix");
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBeUndefined();
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "rebuilt successfully",
    );
  });

  it("syncs the recreate session from registry state instead of another sandbox (#2201)", async () => {
    const harness = createRebuildFlowHarness({ sessionSandboxName: "unrelated-hermes" });
    harness.session.agent = "hermes";
    harness.session.messagingPlan = makeActiveTeamsMessagingPlan();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.session.sandboxName).toBe("alpha");
    expect(harness.session.agent).toBeNull();
    expect(harness.session.messagingPlan).toBeNull();
  });

  it("keeps the validated host NIM runtime alive across sandbox replacement", async () => {
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxEntry: { provider: "vllm-local", nimContainer: "nemoclaw-nim-19080" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.stopNimContainerByNameSpy).not.toHaveBeenCalled();
    expect(harness.stopNimContainerSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).toHaveBeenCalled();
  });

  it("restores the validated pre-upgrade manifest without taking a second backup (#6114)", async () => {
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxListOutput: "alpha Error",
    });
    const recoveryManifest = makePreparedRecoveryManifest();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      recoveryManifest.backupPath,
    );
  });

  it("rejects a mismatched prepared manifest before deleting the sandbox (#6114)", async () => {
    const harness = createRebuildFlowHarness({
      recoveryManifestValidation: () => ({
        ok: false,
        reason: "manifest sandbox 'beta' does not match 'alpha'",
      }),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Invalid recovery manifest");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("revalidates the prepared manifest immediately before deleting the sandbox (#6114)", async () => {
    let validationCount = 0;
    const harness = createRebuildFlowHarness({
      recoveryManifestValidation: (manifest) => {
        validationCount++;
        return validationCount === 1
          ? { ok: true as const, manifest }
          : { ok: false as const, reason: "persisted backup identity changed during validation" };
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Invalid recovery manifest");

    expect(validationCount).toBe(2);
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("rejects same-agent registry configuration drift before deleting the sandbox (#6114)", async () => {
    const harness = createRebuildFlowHarness({
      preDeleteSandboxEntry: {
        name: "alpha",
        provider: "compatible-endpoint",
        model: "new-model",
        policies: ["npm", "github"],
        agent: null,
        agentVersion: "0.1.0",
        nemoclawVersion: "0.0.71",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recovery registry configuration changed during preflight");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("uses the single refreshed registry snapshot for recreate rollback (#6114)", async () => {
    const harness = createRebuildFlowHarness({
      preDeleteDefaultSandbox: "beta",
      onboard: () => {
        throw new Error("recreate failed");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", agentVersion: "0.1.0" }),
      { reclaimDefault: null },
    );
  });

  it("rejects a latest-backup change immediately before deleting the sandbox (#6114)", async () => {
    const harness = createRebuildFlowHarness({
      preDeleteLatestManifest: {
        ...makePreparedRecoveryManifest(),
        timestamp: "2026-07-01T07-00-00-000Z",
        backupPath: "/tmp/rebuild-backups/alpha/2026-07-01T07-00-00-000Z",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest: makePreparedRecoveryManifest(),
      }),
    ).rejects.toThrow("Recovery backup identity changed during preflight");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("restores the registry entry when prepared-backup recreation fails (#6114)", async () => {
    const harness = createRebuildFlowHarness({
      onboard: () => {
        throw new Error("recreate failed");
      },
    });
    const recoveryManifest = makePreparedRecoveryManifest();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", agentVersion: "0.1.0" }),
      { reclaimDefault: "alpha" },
    );
    expect(harness.restoreSandboxStateSpy).not.toHaveBeenCalled();
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
    expect(errors).toContain("Sandbox is untouched");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("aborts before backup/delete when a recorded provider attachment is missing", async () => {
    const harness = createRebuildFlowHarness({
      extraProviders: ["stale-extra-provider"],
      providerPreflightError: new Error(
        "Recorded sandbox provider 'stale-extra-provider' is not registered.",
      ),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded sandbox provider 'stale-extra-provider' is not registered");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("rolls back a partial exact-provider detach before aborting", async () => {
    const harness = createRebuildFlowHarness({
      extraProviders: ["a-provider", "b-provider"],
    });
    harness.runOpenshellSpy.mockImplementation((args: string[]) => {
      const command = args.join(" ");
      if (command === "sandbox provider detach alpha b-provider") {
        return { status: 1, stderr: "status: Internal, gateway timeout", stdout: "" } as never;
      }
      return { status: 0, stderr: "", stdout: "" } as never;
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Failed to detach retained provider 'b-provider'");

    const commands = harness.runOpenshellSpy.mock.calls.map((call) => call[0].join(" "));
    expect(commands).toContain("sandbox provider detach alpha a-provider");
    expect(commands).toContain("sandbox provider detach alpha b-provider");
    expect(commands).toContain("sandbox provider attach alpha a-provider");
    expect(commands).not.toContain("sandbox delete alpha");
    expect(harness.relockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.runOpenshellSpy.mock.invocationCallOrder[
        commands.indexOf("sandbox provider attach alpha a-provider")
      ],
    );
  });

  it("reattaches providers and relocks shields before releasing the lifecycle lock on exit", async () => {
    let providerExitHandler: (() => void) | null = null;
    vi.spyOn(process, "prependOnceListener").mockImplementation(((
      eventName: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (eventName === "exit") providerExitHandler = listener;
      return process;
    }) as typeof process.prependOnceListener);
    const harness = createRebuildFlowHarness({ extraProviders: ["a-provider", "b-provider"] });
    harness.runOpenshellSpy.mockImplementation((args: string[]) => {
      const command = args.join(" ");
      if (command === "sandbox provider detach alpha b-provider") {
        providerExitHandler?.();
        return { status: 1, stderr: "status: Internal, gateway timeout", stdout: "" } as never;
      }
      return { status: 0, stderr: "", stdout: "" } as never;
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Failed to detach retained provider 'b-provider'");

    const commands = harness.runOpenshellSpy.mock.calls.map((call) => call[0].join(" "));
    const attachCallOrder =
      harness.runOpenshellSpy.mock.invocationCallOrder[
        commands.indexOf("sandbox provider attach alpha a-provider")
      ];
    expect(harness.relockSpy.mock.invocationCallOrder[0]).toBeLessThan(attachCallOrder);
    expect(attachCallOrder).toBeLessThan(harness.releaseOnboardLockSpy.mock.invocationCallOrder[0]);
  });

  it("relocks zero-provider rebuilds and cleans retained inputs before re-signaling", async () => {
    let shieldsSigintHandler: (() => void) | null = null;
    let retainedCleanupSigintHandler: (() => void) | null = null;
    vi.spyOn(process, "prependOnceListener").mockImplementation(((
      eventName: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (eventName === "SIGINT" && !shieldsSigintHandler) shieldsSigintHandler = listener;
      return process;
    }) as typeof process.prependOnceListener);
    vi.spyOn(process, "once").mockImplementation(((
      eventName: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (eventName === "SIGINT") retainedCleanupSigintHandler = listener;
      return process;
    }) as typeof process.once);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    const harness = createRebuildFlowHarness({
      onBackup: () => {
        shieldsSigintHandler?.();
        retainedCleanupSigintHandler?.();
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.relockSpy).toHaveBeenCalled();
    expect(harness.preparedBuildContextCleanupSpy).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(harness.relockSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.preparedBuildContextCleanupSpy.mock.invocationCallOrder[0],
    );
    expect(harness.preparedBuildContextCleanupSpy.mock.invocationCallOrder[0]).toBeLessThan(
      killSpy.mock.invocationCallOrder[0],
    );
  });

  it("reattaches retained providers when sandbox deletion fails", async () => {
    const harness = createRebuildFlowHarness({ extraProviders: ["global-provider"] });
    harness.runOpenshellSpy.mockImplementation((args: string[]) =>
      args.join(" ") === "sandbox delete alpha"
        ? ({ status: 1, stderr: "delete failed", stdout: "" } as never)
        : ({ status: 0, stderr: "", stdout: "" } as never),
    );

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Failed to delete sandbox");

    const commands = harness.runOpenshellSpy.mock.calls.map((call) => call[0].join(" "));
    expect(commands).toContain("sandbox provider detach alpha global-provider");
    expect(commands).toContain("sandbox delete alpha");
    expect(commands).toContain("sandbox provider attach alpha global-provider");
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("commits exact-provider detachment after successful deletion", async () => {
    const harness = createRebuildFlowHarness({ extraProviders: ["global-provider"] });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const commands = harness.runOpenshellSpy.mock.calls.map((call) => call[0].join(" "));
    expect(commands).toContain("sandbox provider detach alpha global-provider");
    expect(commands).not.toContain("sandbox provider attach alpha global-provider");
  });

  it("skips provider detachment when recovering a sandbox that is already stale", async () => {
    const harness = createRebuildFlowHarness({
      extraProviders: ["global-provider"],
      staleRecovery: true,
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "provider", "detach", "alpha", "global-provider"],
      expect.anything(),
    );
  });

  it("aborts before detach/delete when global provider state drifts after backup", async () => {
    const harness = createRebuildFlowHarness({
      extraProviders: ["global-provider"],
      postBackupExtraProviders: ["global-provider", "new-provider"],
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Messaging channels or provider attachments changed");

    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "provider", "detach", "alpha", "global-provider"],
      expect.anything(),
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
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
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm"],
    });
    expect(output).toContain("Policy presets failed to reapply: bad, throw");
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
      // The caller's env is left exactly as it was after the rebuild.
      expect(process.env.NEMOCLAW_AGENT).toBe("langchain-deepagents-code");
      expect(process.env.NEMOCLAW_PROVIDER_KEY).toBe("sk-bogus-installer-key");
    } finally {
      restoreEnv();
    }
  });

  it("isolates unrelated structural build env during image preflight and recreate", async () => {
    const restoreEnv = snapshotEnv([
      "NEMOCLAW_EXTRA_AGENTS_JSON",
      "NEMOCLAW_OPENCLAW_OTEL",
      "NEMOCLAW_PROXY_HOST",
    ]);
    process.env.NEMOCLAW_EXTRA_AGENTS_JSON = '[{"name":"unrelated-agent"}]';
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    process.env.NEMOCLAW_PROXY_HOST = "unrelated-proxy";
    let envSeenDuringImage: Record<string, string | undefined> | null = null;
    let envSeenDuringOnboard: Record<string, string | undefined> | null = null;
    try {
      const harness = createRebuildFlowHarness({
        onboard: () => {
          envSeenDuringOnboard = {
            extraAgents: process.env.NEMOCLAW_EXTRA_AGENTS_JSON,
            otel: process.env.NEMOCLAW_OPENCLAW_OTEL,
            proxyHost: process.env.NEMOCLAW_PROXY_HOST,
          };
        },
      });
      harness.imagePreflightSpy.mockImplementation(async () => {
        envSeenDuringImage = {
          extraAgents: process.env.NEMOCLAW_EXTRA_AGENTS_JSON,
          otel: process.env.NEMOCLAW_OPENCLAW_OTEL,
          proxyHost: process.env.NEMOCLAW_PROXY_HOST,
        };
        return {
          ok: true,
          preparedBuildContext: {
            buildCtx: "/tmp/rebuild-flow-preflight",
            stagedDockerfile: "/tmp/rebuild-flow-preflight/Dockerfile",
            buildId: "flow-build",
            dockerGpuPatchNetwork: null,
            cleanupBuildCtx: vi.fn(() => true),
          },
        };
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(envSeenDuringImage).toEqual({
        extraAgents: undefined,
        otel: undefined,
        proxyHost: undefined,
      });
      expect(envSeenDuringOnboard).toEqual(envSeenDuringImage);
      expect(process.env.NEMOCLAW_EXTRA_AGENTS_JSON).toBe('[{"name":"unrelated-agent"}]');
      expect(process.env.NEMOCLAW_OPENCLAW_OTEL).toBe("1");
      expect(process.env.NEMOCLAW_PROXY_HOST).toBe("unrelated-proxy");
    } finally {
      restoreEnv();
    }
  });

  it("does not inherit messaging config or staged plan env from a prior sandbox", async () => {
    const restoreEnv = snapshotEnv(["DISCORD_SERVER_ID", "NEMOCLAW_MESSAGING_PLAN_B64"]);
    process.env.DISCORD_SERVER_ID = "sandbox-a-guild";
    process.env.NEMOCLAW_MESSAGING_PLAN_B64 = "sandbox-a-plan";
    let envSeenDuringOnboard: Record<string, string | undefined> | null = null;
    try {
      const harness = createRebuildFlowHarness({
        onboard: () => {
          envSeenDuringOnboard = {
            discordGuild: process.env.DISCORD_SERVER_ID,
            messagingPlan: process.env.NEMOCLAW_MESSAGING_PLAN_B64,
          };
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(envSeenDuringOnboard).toEqual({
        discordGuild: undefined,
        messagingPlan: undefined,
      });
      expect(process.env.DISCORD_SERVER_ID).toBe("sandbox-a-guild");
      expect(process.env.NEMOCLAW_MESSAGING_PLAN_B64).toBe("sandbox-a-plan");
    } finally {
      restoreEnv();
    }
  });

  it("validates retained Brave egress while ignoring an ambient host key", async () => {
    const restoreEnv = snapshotEnv(["BRAVE_API_KEY"]);
    process.env.BRAVE_API_KEY = "hostile-ambient-brave-key";
    try {
      const harness = createRebuildFlowHarness({ applyPreset: () => true });
      harness.session.webSearchConfig = { fetchEnabled: true };

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.braveRouteSpy).toHaveBeenCalledWith("alpha");
      expect(harness.braveRouteSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(harness.braveCredentialSpy).not.toHaveBeenCalled();
      expect(process.env.BRAVE_API_KEY).toBe("hostile-ambient-brave-key");
    } finally {
      restoreEnv();
    }
  });

  it("aborts untouched when the retained Brave route rejects its gateway credential", async () => {
    const harness = createRebuildFlowHarness();
    harness.session.webSearchConfig = { fetchEnabled: true };
    harness.braveRouteSpy.mockReturnValue({ ok: false, detail: "HTTP 401" });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recorded Brave Search route smoke check failed");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("recreates a matching-session custom-endpoint sandbox from a validated session endpoint while ignoring hostile ambient values for PRA-4 (#5735)", async () => {
    // Matching session (sandboxName === target) with a custom endpoint recorded
    // in that session. Hostile ambient NEMOCLAW_ENDPOINT_URL/PROVIDER/MODEL must
    // be absent during recreate so onboard --resume uses the validated session
    // endpoint selected by prepareRebuildResumeConfig.
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
      // The custom endpoint lives only in this sandbox's own matching session;
      // it is canonicalized at the pre-delete rebuild boundary before rewrite.
      harness.session.provider = "compatible-endpoint";
      harness.session.model = "session-model";
      harness.session.endpointUrl = "https://my-custom-endpoint.example/v1?x=1#frag";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      // Ambient selection env was isolated during the recreate.
      expect(envSeenInsideOnboard).toEqual({
        endpoint: undefined,
        provider: undefined,
        model: undefined,
      });
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

  it("fails closed for a custom-image sandbox whose matching Dockerfile path was lost", async () => {
    const harness = createRebuildFlowHarness({ managedImageEvidence: false });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Cannot recreate a custom-image sandbox");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("aborts before backup/delete when the exact boot policy cannot be prepared", async () => {
    const harness = createRebuildFlowHarness({
      initialPolicyError: new Error("malformed recorded policy YAML"),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("malformed recorded policy YAML");

    expect(harness.imagePreflightSpy).not.toHaveBeenCalled();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
  });

  it("carries custom-only policy content and metadata through authoritative recreation", async () => {
    const customPolicy = {
      name: "internal-api",
      content: "network_policies:\n  internal-api:\n    endpoints: []\n",
      sourcePath: "/tmp/internal-api.yaml",
    };
    let policyPresetsSeenDuringOnboard: unknown = null;
    const harness = createRebuildFlowHarness({
      applyPreset: () => true,
      sandboxEntry: { policies: [], customPolicies: [customPolicy] },
      onboard: (session) => {
        policyPresetsSeenDuringOnboard = session.policyPresets;
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.initialPolicyPreflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        recordedPolicyPresets: [],
        customPolicies: [customPolicy],
      }),
    );
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ authoritativeCustomPolicies: [customPolicy] }),
    );
    expect(policyPresetsSeenDuringOnboard).toEqual(["internal-api"]);
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      customPolicies: [customPolicy],
    });
  });

  it("aborts before backup/delete when persisted resource intent is incomplete", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { resourceCpu: "4", resourceMemory: null },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("CPU and memory must both be non-empty");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("aborts before backup/delete when persisted resource flags cannot be replayed", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { resourceCpu: "4", resourceMemory: "8Gi" },
      targetPreflightError: new Error(
        "Cannot replay persisted sandbox resources: OpenShell lacks required resource flags",
      ),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("OpenShell lacks required resource flags");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("ignores a stale session Dockerfile when registry provenance identifies a managed image", async () => {
    const harness = createRebuildFlowHarness({ applyPreset: () => true });
    harness.session.metadata = { fromDockerfile: "/tmp/stale-custom/Dockerfile" };

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.imagePreflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fromDockerfile: null }),
    );
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fromDockerfile: null }),
    );
    expect(harness.session.metadata).toMatchObject({ fromDockerfile: null });
  });

  it("fails closed instead of disabling recorded Brave search when the session belongs elsewhere", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { policies: ["npm", "brave"] },
      sessionSandboxName: "some-other-sandbox",
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Cannot safely recreate a Brave-enabled sandbox");

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(harness.onboardSpy).not.toHaveBeenCalled();
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
      harness.session.metadata = { fromDockerfile: "/tmp/unrelated/Dockerfile" };

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.onboardSpy).toHaveBeenCalled();
      expect(harness.session.endpointUrl).not.toBe(staleEndpoint);
      expect(harness.session.metadata).toMatchObject({ fromDockerfile: null });
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
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBeUndefined();

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

  it("restores registry and relocks when post-delete session preparation fails", async () => {
    const harness = createRebuildFlowHarness({
      sessionUpdateError: new Error("session storage unavailable"),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("session storage unavailable");

    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      { reclaimDefault: "alpha" },
    );
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("Rebuild failed after the old sandbox was deleted");
    expect(errors).toContain("original registry entry was restored");
  });

  it("relocks a replacement sandbox when onboarding fails after create", async () => {
    const harness = createRebuildFlowHarness({
      onboard: () => {
        throw new Error("post-create finalization failed");
      },
    });
    harness.captureOpenshellSpy.mockImplementation((args: string[]) =>
      args[0] === "sandbox" && args[1] === "list"
        ? ({ status: 0, output: "alpha Ready" } as never)
        : ({ status: 0, output: "" } as never),
    );

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate incomplete (replacement sandbox exists)");

    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(errors).toContain("replacement sandbox exists");
    expect(errors).not.toContain("Recreate failed after sandbox was destroyed");
  });

  it("assumes a replacement exists and relocks when the liveness probe cannot spawn", async () => {
    const harness = createRebuildFlowHarness({
      onboard: () => {
        throw new Error("post-create finalization failed");
      },
    });
    harness.captureOpenshellSpy.mockImplementation((args: string[]) => {
      if (args[0] === "sandbox" && args[1] === "list") process.exit(1);
      return { status: 0, output: "" } as never;
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate incomplete (replacement sandbox exists)");

    expect(harness.restoreSandboxEntrySpy).toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
  });
});
