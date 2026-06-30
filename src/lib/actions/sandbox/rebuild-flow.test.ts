// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-harness";

const requireDist = createRequire(import.meta.url);
const rebuildModulePath = "./rebuild.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(rebuildModulePath);
delete require.cache[requireDist.resolve(rebuildModulePath)];

const originalSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;

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
      sandboxEntry: {
        provider: "compatible-endpoint",
        model: "custom-model",
        endpointUrl: "https://inference.example.test/v1?ignored=1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
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
        rebuildRegistryInferenceRoute: {
          sandboxName: "alpha",
          route: {
            provider: "compatible-endpoint",
            model: "custom-model",
            endpointUrl: "https://inference.example.test/v1",
            preferredInferenceApi: "openai-completions",
            source: "registry",
          },
        },
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
      "NEMOCLAW_REASONING",
      "COMPATIBLE_API_KEY",
    ]);
    process.env.NEMOCLAW_ENDPOINT_URL = "https://attacker.example.test/v1";
    process.env.NEMOCLAW_PROVIDER = "build";
    process.env.NEMOCLAW_MODEL = "attacker-model";
    process.env.NEMOCLAW_REASONING = "false";
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
            reasoning: process.env.NEMOCLAW_REASONING,
          };
        },
      });
      // The custom endpoint lives only in this sandbox's own matching session;
      // it is canonicalized at the pre-delete rebuild boundary before rewrite.
      harness.session.endpointUrl = "https://my-custom-endpoint.example/v1?x=1#frag";
      harness.session.provider = "compatible-endpoint";
      harness.session.model = "session-model";
      harness.session.compatibleEndpointReasoning = "true";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      // Ambient selection env was isolated during the recreate.
      expect(envSeenInsideOnboard).toEqual({
        endpoint: undefined,
        provider: undefined,
        model: undefined,
        reasoning: undefined,
      });
      expect(harness.session.endpointUrl).toBe("https://my-custom-endpoint.example/v1");
      // Provider/model come from the registry entry, not the ambient values.
      expect(harness.session.provider).toBe("compatible-endpoint");
      expect(harness.session.model).toBe("session-model");
      expect(harness.session.compatibleEndpointReasoning).toBe("true");
      // Caller env restored afterward.
      expect(process.env.NEMOCLAW_ENDPOINT_URL).toBe("https://attacker.example.test/v1");
      expect(process.env.NEMOCLAW_PROVIDER).toBe("build");
      expect(process.env.NEMOCLAW_MODEL).toBe("attacker-model");
      expect(process.env.NEMOCLAW_REASONING).toBe("false");
    } finally {
      restoreEnv();
    }
  });

  it("leaves a keyless custom sandbox live when only its session has an endpoint", async () => {
    const restoreEnv = snapshotEnv(["COMPATIBLE_API_KEY"]);
    delete process.env.COMPATIBLE_API_KEY;
    try {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          provider: "compatible-endpoint",
          model: "session-model",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
        },
      });
      harness.session.provider = "compatible-endpoint";
      harness.session.model = "session-model";
      harness.session.endpointUrl = "https://session-only.example.test/v1";
      harness.session.credentialEnv = "COMPATIBLE_API_KEY";
      harness.session.preferredInferenceApi = "openai-completions";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Unsafe gateway credential reuse");

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
    expect(harness.restoreRegistryEntryIfMissingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha", imageTag: null }),
    );
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

  it("restores retry metadata when session rewind throws after registry removal", async () => {
    const harness = createRebuildFlowHarness({
      updateSession: () => {
        throw new Error("session rewind boom");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("session rewind boom");

    expect(harness.restoreRegistryEntryIfMissingSpy).toHaveBeenCalledWith({
      name: "alpha",
      imageTag: null,
    });
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });
});
