// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CheckpointProviderBinding } from "../../../state/onboard-checkpoint-types";
import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  createDeps,
  makeMinimalPlan,
  withTelegramCredentialHash,
} from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

const braveConfig = { fetchEnabled: true as const, provider: "brave" as const };
const resourceProfiles: [string, { cpu: string; memory: string } | null][] = [
  ["OpenShell defaults", null],
  ["a selected profile", { cpu: "75%", memory: "75%" }],
];

describe("sandbox create intent machine boundary", () => {
  it("rejects deterministic create conflicts before resume recreation mutates state (#6226)", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const resolveSandboxCreateIntent = vi.fn(async () => {
      throw new Error("messaging provider conflict");
    });
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getStoredMessagingChannelConfig: () => ({ TELEGRAM_REQUIRE_MENTION: "1" }),
      hydrateMessagingChannelConfig: () => ({ TELEGRAM_REQUIRE_MENTION: "0" }),
      messagingChannelConfigsEqual: () => false,
      resolveSandboxCreateIntent,
    });

    await expect(
      handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" }),
    ).rejects.toThrow("messaging provider conflict");

    expect(resolveSandboxCreateIntent).toHaveBeenCalledTimes(1);
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.repairSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("produces equivalent complete intent for equivalent fresh and resumed selections (#6226)", async () => {
    const variants = [
      { fresh: false, resume: false, env: {} },
      { fresh: true, resume: false, env: {} },
      { fresh: false, resume: true, env: { NEMOCLAW_NON_INTERACTIVE: "1" } },
    ];
    const resolvedIntents: unknown[] = [];

    for (const variant of variants) {
      const session = createSession({ sandboxName: "same-sandbox" });
      const { deps, calls } = createDeps();
      calls.setupMessaging.mockResolvedValue(["telegram"]);
      await handleSandboxState({
        ...baseOptions(deps, session),
        ...variant,
        sandboxName: "same-sandbox",
        selectedMessagingChannels: ["telegram"],
      });
      const createIntent = calls.createSandbox.mock.calls[0]?.at(-1) as unknown as {
        resolved: unknown;
      };
      expect(createIntent).toMatchObject({
        resolved: {
          sandboxName: "same-sandbox",
          activeMessagingChannels: [],
          messagingProviderRequests: [],
          reusableMessagingProviders: [],
          extraProviders: [],
          staleExtraProviders: [],
          hermesToolGateways: [],
          policy: {
            basePolicyPath: "/repo/policy.yaml",
            activeMessagingChannels: [],
            options: {
              directGpu: false,
              additionalPresets: [],
              policyTier: null,
              baselineExclusions: [],
            },
          },
          gpuCreateArgs: [],
          resourceCreateArgs: [],
          gpuRoutePlan: "none",
          sandboxGpuLogMessage: null,
          disabledChannelNames: [],
          extraPlaceholderKeys: [],
        },
        recreate: expect.any(Boolean),
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        extraProviders: [],
      });
      const serializedIntent = JSON.stringify(createIntent);
      expect(JSON.parse(serializedIntent)).toEqual(createIntent);
      expect(serializedIntent).not.toMatch(/stored-|resolved-|secret-value|token-value/iu);
      resolvedIntents.push(createIntent.resolved);
      expect(calls.startStep).toHaveBeenCalledWith("sandbox", {
        sandboxName: "same-sandbox",
        provider: "provider",
        model: "model",
      });
      expect(session).not.toHaveProperty("resolved");
    }

    expect(resolvedIntents[1]).toEqual(resolvedIntents[0]);
    expect(resolvedIntents[2]).toEqual(resolvedIntents[0]);
  });

  it("checkpoints a known sandbox name before an interrupted web-search prompt (#6743)", async () => {
    const durableSession = createSession();
    const updateSession = vi.fn((mutator: (value: typeof durableSession) => void) => {
      mutator(durableSession);
      return durableSession;
    });
    const configureWebSearch = vi.fn(async () => {
      throw new Error("web-search prompt interrupted");
    });
    const { deps, calls } = createDeps({ updateSession, configureWebSearch });

    await expect(
      handleSandboxState({ ...baseOptions(deps, durableSession), sandboxName: "tm" }),
    ).rejects.toThrow("web-search prompt interrupted");

    expect(durableSession.sandboxName).toBe("tm");
    expect(durableSession.sandboxPromptProgress).toMatchObject({
      sandboxName: true,
      webSearch: false,
      messaging: false,
      resourceProfile: false,
    });
    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.selectResourceProfile).not.toHaveBeenCalled();
  });

  it("prompts and checkpoints a missing sandbox name before web-search selection (#6743)", async () => {
    const durableSession = createSession();
    const updateSession = vi.fn((mutator: (value: typeof durableSession) => void) => {
      mutator(durableSession);
      return durableSession;
    });
    const events: string[] = [];
    const configureWebSearch = vi.fn(async () => {
      events.push("web-search");
      throw new Error("web-search prompt interrupted");
    });
    const { deps, calls } = createDeps({ updateSession, configureWebSearch });
    calls.promptName.mockImplementationOnce(async () => {
      events.push("sandbox-name");
      return "tm";
    });

    await expect(handleSandboxState(baseOptions(deps, durableSession))).rejects.toThrow(
      "web-search prompt interrupted",
    );

    expect(events).toEqual(["sandbox-name", "web-search"]);
    expect(durableSession.sandboxName).toBe("tm");
    expect(durableSession.sandboxPromptProgress).toMatchObject({
      sandboxName: true,
      webSearch: false,
      messaging: false,
      resourceProfile: false,
    });
    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.selectResourceProfile).not.toHaveBeenCalled();
  });

  it("invalidates sandbox-bound messaging when an explicit resume name changes (#6743)", async () => {
    const durableSession = createSession({
      sandboxName: "old-name",
      webSearchConfig: null,
      messagingPlan: makeMinimalPlan("old-name"),
      resourceProfile: null,
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: false,
      },
    });
    const updateSession = vi.fn((mutator: (value: typeof durableSession) => void) => {
      mutator(durableSession);
      return durableSession;
    });
    const { deps, calls } = createDeps({ updateSession });
    calls.setupMessaging.mockRejectedValueOnce(new Error("messaging selection interrupted"));

    await expect(
      handleSandboxState({
        ...baseOptions(deps, durableSession),
        resume: true,
        sandboxName: "new-name",
      }),
    ).rejects.toThrow("messaging selection interrupted");

    expect(calls.clearPlanEnv).toHaveBeenCalledTimes(1);
    expect(calls.setupMessaging).toHaveBeenCalledWith(null, null, "new-name");
    expect(durableSession.sandboxName).toBe("new-name");
    expect(durableSession.messagingPlan).toBeNull();
    expect(durableSession.sandboxPromptProgress.messaging).toBe(false);
  });

  it("resumes at the interrupted resource prompt after checkpointing earlier choices (#6743)", async () => {
    const braveCredential = "brave-secret-value";
    const telegramCredential = "telegram-secret-value";
    const messagingPlan = withTelegramCredentialHash(
      makeMinimalPlan("tm", "openclaw", ["telegram"]),
      "a".repeat(64),
    );
    const credentialEnv = {
      BRAVE_API_KEY: braveCredential,
      TELEGRAM_BOT_TOKEN: telegramCredential,
    };
    const durableSession = createSession();
    const updateSession = vi.fn((mutator: (value: typeof durableSession) => void) => {
      mutator(durableSession);
      return durableSession;
    });
    const recordStepComplete = vi.fn(async (_stepName: string, updates: object) => {
      Object.assign(durableSession, updates);
      return durableSession;
    });
    const configureWebSearch = vi.fn(async () => braveConfig);
    const setupMessagingChannels = vi.fn(async () => ["telegram"]);
    const providerMatchesGatewayCredential = vi.fn(
      (name: string, type: string, credentialEnvName: string) =>
        (name === "tm-brave-search" && type === "brave" && credentialEnvName === "BRAVE_API_KEY") ||
        (name === "tm-telegram-bridge" &&
          type === "generic" &&
          credentialEnvName === "TELEGRAM_BOT_TOKEN"),
    );
    const stageSandboxCredentialProviders = vi
      .fn<() => Promise<CheckpointProviderBinding[]>>()
      .mockImplementationOnce(async () => {
        durableSession.stagedCredentialProviders = ["tm-brave-search"];
        return [{ name: "tm-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" }];
      })
      .mockImplementationOnce(async () => {
        durableSession.stagedCredentialProviders.push("tm-telegram-bridge");
        return [
          { name: "tm-telegram-bridge", type: "generic", credentialEnv: "TELEGRAM_BOT_TOKEN" },
        ];
      })
      .mockResolvedValue([]);
    const readMessagingPlanFromEnv = vi
      .fn<() => typeof messagingPlan | null>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(messagingPlan)
      .mockReturnValue(null);
    const { deps, calls } = createDeps({
      updateSession,
      recordStepComplete,
      configureWebSearch,
      setupMessagingChannels,
      providerMatchesGatewayCredential,
      stageSandboxCredentialProviders,
      readMessagingPlanFromEnv,
    });
    calls.selectResourceProfile.mockRejectedValueOnce(new Error("resource prompt interrupted"));

    await expect(
      handleSandboxState({
        ...baseOptions(deps, durableSession),
        sandboxName: "tm",
        env: credentialEnv,
      }),
    ).rejects.toThrow("resource prompt interrupted");

    expect(durableSession).toMatchObject({
      sandboxName: "tm",
      webSearchConfig: braveConfig,
      messagingPlan,
      stagedCredentialProviders: ["tm-brave-search", "tm-telegram-bridge"],
      resourceProfile: null,
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: false,
      },
    });
    expect(calls.resolveCreateIntent).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(stageSandboxCredentialProviders).toHaveBeenCalledWith({
      sandboxName: "tm",
      enabledChannels: [],
      webSearchConfig: braveConfig,
      agent: null,
    });
    expect(stageSandboxCredentialProviders.mock.invocationCallOrder[0]).toBeLessThan(
      setupMessagingChannels.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(stageSandboxCredentialProviders.mock.invocationCallOrder[0]).toBeLessThan(
      calls.selectResourceProfile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(stageSandboxCredentialProviders).toHaveBeenNthCalledWith(2, {
      sandboxName: "tm",
      enabledChannels: ["telegram"],
      webSearchConfig: null,
      agent: null,
    });
    expect(stageSandboxCredentialProviders.mock.invocationCallOrder[1]).toBeGreaterThan(
      setupMessagingChannels.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
    expect(stageSandboxCredentialProviders.mock.invocationCallOrder[1]).toBeLessThan(
      calls.selectResourceProfile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    calls.selectResourceProfile.mockResolvedValueOnce({ cpu: "75%", memory: "75%" });
    await handleSandboxState({
      ...baseOptions(deps, durableSession),
      resume: true,
      sandboxName: durableSession.sandboxName,
      webSearchConfig: durableSession.webSearchConfig,
      env: {},
    });

    expect(configureWebSearch).toHaveBeenCalledTimes(1);
    expect(setupMessagingChannels).toHaveBeenCalledTimes(1);
    expect(calls.validateBrave).not.toHaveBeenCalled();
    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "tm-brave-search",
      "brave",
      "BRAVE_API_KEY",
    );
    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "tm-telegram-bridge",
      "generic",
      "TELEGRAM_BOT_TOKEN",
    );
    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.selectResourceProfile).toHaveBeenCalledTimes(2);
    expect(calls.resolveCreateIntent).toHaveBeenCalledTimes(1);
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(durableSession.sandboxPromptProgress.resourceProfile).toBe(true);
    expect(durableSession.resourceProfile).toEqual({ cpu: "75%", memory: "75%" });

    const serializedSession = JSON.stringify(durableSession);
    expect(serializedSession).not.toContain(braveCredential);
    expect(serializedSession).not.toContain(telegramCredential);
    expect(serializedSession).not.toContain('"resolved"');
    expect(serializedSession).not.toContain('"resourceCreateArgs"');
  });

  it("keeps an active channel choice but reacquires its missing credential after restart (#6743)", async () => {
    const messagingPlan = withTelegramCredentialHash(
      makeMinimalPlan("tm", "openclaw", ["telegram"]),
      "a".repeat(64),
    );
    const durableSession = createSession({
      sandboxName: "tm",
      webSearchConfig: null,
      messagingPlan,
      resourceProfile: null,
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
    });
    const updateSession = vi.fn((mutator: (value: typeof durableSession) => void) => {
      mutator(durableSession);
      return durableSession;
    });
    const { deps, calls } = createDeps({ updateSession });
    calls.setupMessaging.mockRejectedValueOnce(new Error("telegram token prompt interrupted"));

    await expect(
      handleSandboxState({
        ...baseOptions(deps, durableSession),
        resume: true,
        sandboxName: "tm",
      }),
    ).rejects.toThrow("telegram token prompt interrupted");

    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.setupMessaging).toHaveBeenCalledWith(null, ["telegram"], "tm", {
      selectionCompleted: true,
    });
    expect(calls.selectResourceProfile).not.toHaveBeenCalled();
    expect(calls.resolveCreateIntent).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(durableSession.messagingPlan).toEqual(messagingPlan);
    expect(durableSession.sandboxPromptProgress.messaging).toBe(true);
  });

  it("keeps a completed disabled channel choice without reacquiring credentials (#6743)", async () => {
    const messagingPlan = withTelegramCredentialHash(
      makeMinimalPlan("tm", "openclaw", ["telegram"], ["telegram"]),
      "a".repeat(64),
    );
    const durableSession = createSession({
      sandboxName: "tm",
      webSearchConfig: null,
      messagingPlan,
      resourceProfile: null,
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
    });
    const updateSession = vi.fn((mutator: (value: typeof durableSession) => void) => {
      mutator(durableSession);
      return durableSession;
    });
    const recordStepComplete = vi.fn(async (_stepName: string, updates: object) => {
      Object.assign(durableSession, updates);
      return durableSession;
    });
    const { deps, calls } = createDeps({ updateSession, recordStepComplete });

    const result = await handleSandboxState({
      ...baseOptions(deps, durableSession),
      resume: true,
      sandboxName: "tm",
    });

    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.showMessagingStage).toHaveBeenCalledOnce();
    expect(calls.selectResourceProfile).not.toHaveBeenCalled();
    expect(calls.note).toHaveBeenCalledWith("  [resume] Reusing web search selection: disabled.");
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Reusing messaging selection: no active channels.",
    );
    expect(calls.note).toHaveBeenCalledWith("  [resume] Reusing OpenShell default resources.");
    expect(calls.resolveCreateIntent).toHaveBeenCalledWith(
      expect.objectContaining({ enabledChannels: [] }),
    );
    expect((calls.createSandbox.mock.calls[0] as unknown[])[6]).toEqual([]);
    expect(result.selectedMessagingChannels).toEqual([]);
  });

  it.each(
    resourceProfiles,
  )("reuses %s after intent resolution is interrupted and recomputes the intent (#6743)", async (_label, selectedResourceProfile) => {
    const messagingPlan = makeMinimalPlan("tm");
    const durableSession = createSession({
      sandboxName: "tm",
      webSearchConfig: braveConfig,
      messagingPlan,
      resourceProfile: null,
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: false,
      },
    });
    const updateSession = vi.fn((mutator: (value: typeof durableSession) => void) => {
      mutator(durableSession);
      return durableSession;
    });
    const recordStepComplete = vi.fn(async (_stepName: string, updates: object) => {
      Object.assign(durableSession, updates);
      return durableSession;
    });
    const { deps, calls } = createDeps({ updateSession, recordStepComplete });
    calls.selectResourceProfile.mockResolvedValue(selectedResourceProfile);
    calls.resolveCreateIntent.mockRejectedValueOnce(new Error("intent resolution interrupted"));

    const options = () => ({
      ...baseOptions(deps, durableSession),
      resume: true,
      sandboxName: durableSession.sandboxName,
      webSearchConfig: durableSession.webSearchConfig,
    });
    await expect(handleSandboxState(options())).rejects.toThrow("intent resolution interrupted");

    expect(durableSession.sandboxPromptProgress.resourceProfile).toBe(true);
    expect(durableSession.resourceProfile).toEqual(selectedResourceProfile);
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();

    await handleSandboxState(options());

    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.selectResourceProfile).toHaveBeenCalledTimes(1);
    expect(calls.resolveCreateIntent).toHaveBeenCalledTimes(2);
    expect(calls.resolveCreateIntent.mock.calls[1]?.[0]).toEqual(
      calls.resolveCreateIntent.mock.calls[0]?.[0],
    );
    expect(calls.resolveCreateIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ resourceProfile: selectedResourceProfile }),
    );
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect((calls.createSandbox.mock.calls[0] as unknown[])[11]).toEqual(selectedResourceProfile);

    const serializedSession = JSON.stringify(durableSession);
    expect(serializedSession).not.toContain('"resolved"');
    expect(serializedSession).not.toContain('"resourceCreateArgs"');
  });
});
