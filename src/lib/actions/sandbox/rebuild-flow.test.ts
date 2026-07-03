// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRebuildFlowHarness,
  makePreparedRecoveryManifest,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-harness";

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
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

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
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm", "bad", "throw"],
    });
    expect(harness.executeSandboxCommandSpy).toHaveBeenCalledWith("alpha", "openclaw doctor --fix");
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe("alpha");
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "rebuilt successfully",
    );
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
