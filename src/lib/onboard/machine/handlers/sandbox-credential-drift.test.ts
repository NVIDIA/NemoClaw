// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import { hashCredential } from "../../../security/credential-hash";
import { createSession } from "../../../state/onboard-session";
import {
  recordCheckpointEffectGroup,
  recordCheckpointMessaging,
  recordCheckpointProviderEffectGroup,
  recordCheckpointSandboxIdentity,
} from "../../checkpoint-record";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import {
  baseOptions,
  createDeps,
  makeMinimalPlan,
  withEnv,
  withTelegramCredentialHash,
} from "./sandbox-test-fixtures";

// Messaging discovery is mocked at import time to isolate credential-drift resume behavior.
vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
  readMessagingPlanFromEnv: vi.fn(() => null),
  getRegistrySandboxMessagingAuthority: vi.fn(() => ({
    authoritative: false,
    plan: null,
  })),
}));

const detectMessagingChannelsFromEnvMock = vi.mocked(detectMessagingChannelsFromEnv);
const registryEnvironment = vi.hoisted(() => {
  const previousHome = process.env.HOME;
  const registryHome = `${process.env.TMPDIR ?? "/tmp"}/nemoclaw-credential-drift-${process.pid}-${Date.now()}`;
  process.env.HOME = registryHome;
  return { previousHome, registryHome };
});
const { registryHome } = registryEnvironment;
let registry: typeof import("../../../state/registry");
let handleSandboxState: typeof import("./sandbox").handleSandboxState;
let persistManifestChannelDisabledPlan: typeof import("../../../actions/sandbox/policy-channel").persistManifestChannelDisabledPlan;

beforeAll(async () => {
  ({ handleSandboxState } = await import("./sandbox"));
  ({ persistManifestChannelDisabledPlan } =
    await import("../../../actions/sandbox/policy-channel"));
  registry = await import("../../../state/registry");

  const registryPath = path.relative(registryHome, registry.REGISTRY_FILE);
  expect(registryPath.startsWith("..")).toBe(false);
  expect(path.isAbsolute(registryPath)).toBe(false);
});

afterAll(async () => {
  const restoreHome =
    registryEnvironment.previousHome === undefined
      ? () => Reflect.deleteProperty(process.env, "HOME")
      : () => {
          process.env.HOME = registryEnvironment.previousHome;
        };
  restoreHome();
  await rm(registryHome, { recursive: true, force: true });
});

describe("sandbox messaging credential drift", () => {
  beforeEach(() => {
    registry.clearAll();
    detectMessagingChannelsFromEnvMock.mockReturnValue([]);
  });

  it("restages a validated replacement credential despite a live provider receipt (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:replacement-telegram-token";
    const previousPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const replacementPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(replacementToken),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: previousPlan });
    session.steps.sandbox.status = "complete";
    recordCheckpointMessaging(session, previousPlan);
    recordCheckpointProviderEffectGroup(session, "messaging_providers", [
      {
        name: "saved-telegram-bridge",
        type: "generic",
        credentialEnv: "TELEGRAM_BOT_TOKEN",
      },
    ]);
    const messagingEnv: NodeJS.ProcessEnv = {};
    const writePlanToEnv = (plan: typeof replacementPlan) =>
      MessagingSetupApplier.writePlanToEnv(plan, { env: messagingEnv });
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingAuthority: () => ({
          authoritative: true,
          plan: previousPlan,
        }),
        getRecordedMessagingChannelsForResume: () => null,
        readMessagingPlanFromEnv: () =>
          MessagingSetupApplier.readPlanFromEnv({ env: messagingEnv }),
        writePlanToEnv,
        providerMatchesGatewayCredential: () => true,
      },
      session,
    );
    calls.setupMessaging.mockImplementation(async () => {
      writePlanToEnv(replacementPlan);
      return ["telegram"];
    });

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        env: { TELEGRAM_BOT_TOKEN: replacementToken },
      });
    });

    expect(calls.stageCredentialProviders).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "saved", enabledChannels: ["telegram"] }),
    );
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("restages a replacement plan discovered after the initial drift decision (#3631)", async () => {
    const previousPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential("123456:previous-telegram-token"),
    );
    const replacementPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential("123456:replacement-telegram-token"),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: previousPlan });
    recordCheckpointMessaging(session, previousPlan);
    recordCheckpointProviderEffectGroup(session, "messaging_providers", [
      {
        name: "saved-telegram-bridge",
        type: "generic",
        credentialEnv: "TELEGRAM_BOT_TOKEN",
      },
    ]);
    const { deps, calls } = createDeps(
      {
        getRegistrySandboxMessagingAuthority: () => ({ authoritative: false, plan: null }),
        readMessagingPlanFromEnv: () => replacementPlan,
        providerMatchesGatewayCredential: () => true,
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      sandboxName: "saved",
      env: {},
    });

    expect(calls.stageCredentialProviders).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "saved", enabledChannels: ["telegram"] }),
    );
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("validates registry-only credential drift before removing the sandbox (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:rejected-telegram-token";
    const previousPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    session.sandboxPromptProgress.messaging = true;
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingAuthority: () => ({
          authoritative: true,
          plan: previousPlan,
        }),
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );
    calls.setupMessaging.mockResolvedValueOnce([]);

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await expect(
        handleSandboxState({
          ...baseOptions(deps, session),
          resume: true,
          sandboxName: "saved",
          env: { TELEGRAM_BOT_TOKEN: replacementToken },
        }),
      ).rejects.toThrow(
        "Credential validation did not complete for active messaging channels: telegram. The existing sandbox was not changed.",
      );
    });

    expect(calls.setupMessaging).toHaveBeenCalled();
    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.selectResourceProfile).not.toHaveBeenCalled();
    expect(calls.planRegisteredExtraProviders).not.toHaveBeenCalled();
    expect(calls.resolveCreateIntent).not.toHaveBeenCalled();
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.restoreSandboxRegistryEntryIfMissing).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("validates registry credential drift during ordinary re-onboarding (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:rejected-telegram-token";
    const previousPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const session = createSession({ sandboxName: "saved" });
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingAuthority: () => ({
          authoritative: true,
          plan: previousPlan,
        }),
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );
    calls.setupMessaging.mockResolvedValueOnce([]);

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await expect(
        handleSandboxState({
          ...baseOptions(deps, session),
          resume: false,
          sandboxName: "saved",
          env: { TELEGRAM_BOT_TOKEN: replacementToken },
        }),
      ).rejects.toThrow(
        "Credential validation did not complete for active messaging channels: telegram. The existing sandbox was not changed.",
      );
    });

    expect(calls.setupMessaging).toHaveBeenCalled();
    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.selectResourceProfile).not.toHaveBeenCalled();
    expect(calls.planRegisteredExtraProviders).not.toHaveBeenCalled();
    expect(calls.resolveCreateIntent).not.toHaveBeenCalled();
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.restoreSandboxRegistryEntryIfMissing).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("validates registry credential drift before checkpoint crash recovery can reuse (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:rejected-telegram-token";
    const previousPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: previousPlan,
    });
    recordCheckpointSandboxIdentity(session, "saved", "openclaw");
    recordCheckpointMessaging(session, previousPlan);
    recordCheckpointEffectGroup(
      session,
      "sandbox_create",
      [
        "saved",
        "default",
        "provider",
        "model",
        "openai-completions",
        "",
        JSON.stringify({ sandboxGpuEnabled: false, mode: "0" }),
        "",
      ].join("|"),
    );
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingAuthority: () => ({
          authoritative: true,
          plan: previousPlan,
        }),
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );
    calls.setupMessaging.mockResolvedValueOnce([]);

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await expect(
        handleSandboxState({
          ...baseOptions(deps, session),
          resume: true,
          sandboxName: "saved",
          env: { TELEGRAM_BOT_TOKEN: replacementToken },
        }),
      ).rejects.toThrow(
        "Credential validation did not complete for active messaging channels: telegram. The existing sandbox was not changed.",
      );
    });

    expect(calls.setupMessaging).toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("validates registry credential drift after the session already refreshed its hash (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:replacement-telegram-token";
    const registryPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const refreshedSessionPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(replacementToken),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: refreshedSessionPlan });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getRegistrySandboxMessagingAuthority: () => ({
        authoritative: true,
        plan: registryPlan,
      }),
      getRecordedMessagingChannelsForResume: () => null,
    });
    calls.setupMessaging.mockResolvedValueOnce([]);

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await expect(
        handleSandboxState({
          ...baseOptions(deps, session),
          resume: true,
          sandboxName: "saved",
          env: { TELEGRAM_BOT_TOKEN: replacementToken },
        }),
      ).rejects.toThrow(
        "Credential validation did not complete for active messaging channels: telegram. The existing sandbox was not changed.",
      );
    });

    expect(calls.setupMessaging).toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps an explicitly disabled registry channel disabled when credentials change (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:replacement-telegram-token";
    const disabledPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"], ["telegram"]),
      hashCredential(previousToken),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: disabledPlan });
    session.steps.sandbox.status = "complete";
    session.machine = { ...session.machine, state: "agent_setup" };
    session.sandboxPromptProgress.messaging = true;
    recordCheckpointMessaging(session, disabledPlan);
    const { deps, calls, getSession } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingAuthority: () => ({
          authoritative: true,
          plan: disabledPlan,
        }),
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        env: { TELEGRAM_BOT_TOKEN: replacementToken },
      });
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(getSession().messagingPlan).toEqual(disabledPlan);
  });

  it("keeps a channel stopped after its completed checkpoint becomes stale (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:replacement-telegram-token";
    const activePlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: activePlan });
    session.steps.sandbox.status = "complete";
    session.machine = { ...session.machine, state: "agent_setup" };
    session.sandboxPromptProgress.messaging = true;
    recordCheckpointMessaging(session, activePlan);
    registry.registerSandbox({
      name: "saved",
      agent: "openclaw",
      messaging: { schemaVersion: 1, plan: activePlan },
    });
    const stoppedPlan = await persistManifestChannelDisabledPlan("saved", "telegram", true);
    expect(stoppedPlan?.workflow).toBe("stop-channel");
    expect(stoppedPlan?.disabledChannels).toEqual(["telegram"]);

    const { deps, calls, getSession } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingAuthority: (name) => ({
          authoritative: true,
          plan: registry.getHydratedMessagingPlanFromEntry(registry.getSandbox(name)),
        }),
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        env: { TELEGRAM_BOT_TOKEN: replacementToken },
      });
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
    expect(getSession().messagingPlan?.workflow).toBe("stop-channel");
    expect(getSession().messagingPlan?.disabledChannels).toEqual(["telegram"]);
    expect(getSession().checkpoint?.messaging).toEqual(
      expect.objectContaining({
        value: expect.objectContaining({ disabledChannels: ["telegram"] }),
      }),
    );
  });

  it("keeps a registry-stopped channel disabled during ordinary re-onboarding (#3631)", async () => {
    const previousToken = "123456:previous-telegram-token";
    const replacementToken = "123456:replacement-telegram-token";
    const activePlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(previousToken),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: activePlan });
    session.steps.sandbox.status = "complete";
    recordCheckpointMessaging(session, activePlan);
    registry.registerSandbox({
      name: "saved",
      agent: "openclaw",
      messaging: { schemaVersion: 1, plan: activePlan },
    });
    const stoppedPlan = await persistManifestChannelDisabledPlan("saved", "telegram", true);
    expect(stoppedPlan?.workflow).toBe("stop-channel");
    detectMessagingChannelsFromEnvMock.mockReturnValue(["telegram"]);

    const { deps, calls, getSession } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingAuthority: (name) => ({
          authoritative: true,
          plan: registry.getHydratedMessagingPlanFromEntry(registry.getSandbox(name)),
        }),
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );

    await withEnv("TELEGRAM_BOT_TOKEN", replacementToken, async () => {
      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: false,
        sandboxName: "saved",
        env: { TELEGRAM_BOT_TOKEN: replacementToken },
      });
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalled();
    expect(getSession().messagingPlan?.workflow).toBe("stop-channel");
    expect(getSession().messagingPlan?.disabledChannels).toEqual(["telegram"]);
    expect(getSession().checkpoint?.messaging).toEqual(
      expect.objectContaining({
        value: expect.objectContaining({ disabledChannels: ["telegram"] }),
      }),
    );
  });

  it("keeps a registry-stopped channel disabled during an unrelated recreation (#3631)", async () => {
    const token = "123456:telegram-token";
    const activePlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(token),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: activePlan });
    session.steps.sandbox.status = "complete";
    session.sandboxPromptProgress.messaging = true;
    recordCheckpointMessaging(session, activePlan);
    registry.registerSandbox({
      name: "saved",
      agent: "openclaw",
      messaging: { schemaVersion: 1, plan: activePlan },
    });
    const stoppedPlan = await persistManifestChannelDisabledPlan("saved", "telegram", true);
    expect(stoppedPlan?.workflow).toBe("stop-channel");

    const { deps, calls, getSession } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getRegistrySandboxMessagingAuthority: (name) => ({
          authoritative: true,
          plan: registry.getHydratedMessagingPlanFromEntry(registry.getSandbox(name)),
        }),
        getRecordedMessagingChannelsForResume: () => null,
      },
      session,
    );

    await withEnv("TELEGRAM_BOT_TOKEN", token, async () => {
      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        recreateSandbox: () => true,
        sandboxName: "saved",
        env: { TELEGRAM_BOT_TOKEN: token },
      });
    });

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalled();
    expect(getSession().messagingPlan?.workflow).toBe("stop-channel");
    expect(getSession().messagingPlan?.disabledChannels).toEqual(["telegram"]);
    expect(getSession().checkpoint?.messaging).toEqual(
      expect.objectContaining({
        value: expect.objectContaining({ disabledChannels: ["telegram"] }),
      }),
    );
  });

  it("aborts a late-named recreation when channel state changes before the sandbox lock (#3631)", async () => {
    const activePlan = makeMinimalPlan("my-assistant", "openclaw", ["telegram"]);
    const stoppedPlan = {
      ...makeMinimalPlan("my-assistant", "openclaw", ["telegram"], ["telegram"]),
      workflow: "stop-channel" as const,
    };
    let sandboxLockHeld = false;
    const { deps, calls } = createDeps({
      getRegistrySandboxMessagingAuthority: () => ({
        authoritative: true,
        plan: sandboxLockHeld ? stoppedPlan : activePlan,
      }),
      withSandboxMutationLock: async (sandboxName, operation) => {
        expect(sandboxName).toBe("my-assistant");
        sandboxLockHeld = true;
        try {
          return await operation();
        } finally {
          sandboxLockHeld = false;
        }
      },
    });

    await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.promptName).toHaveBeenCalledOnce();
    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining("Messaging channel state for sandbox 'my-assistant' changed"),
    );
    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("allows rebuild recreation when manifest-derived messaging fields are rehydrated", async () => {
    const plan = makeMinimalPlan("my-assistant", "openclaw", ["telegram"]);
    const rehydratedPlan = {
      ...plan,
      buildSteps: [
        {
          channelId: "telegram",
          kind: "build-arg",
          outputId: "telegram-config",
          required: true,
          value: "enabled",
        },
      ],
    } satisfies typeof plan;
    let sandboxLockHeld = false;
    const { deps, calls } = createDeps({
      getRegistrySandboxMessagingAuthority: () => ({
        authoritative: true,
        plan: sandboxLockHeld ? rehydratedPlan : plan,
      }),
      withSandboxMutationLock: async (_sandboxName, operation) => {
        sandboxLockHeld = true;
        try {
          return await operation();
        } finally {
          sandboxLockHeld = false;
        }
      },
    });

    await handleSandboxState(baseOptions(deps));

    expect(calls.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Messaging channel state"),
    );
    expect(calls.createSandbox).toHaveBeenCalledOnce();
  });
});
