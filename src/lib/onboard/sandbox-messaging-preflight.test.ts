// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  prepareSandboxMessagingPreflight,
  type SandboxMessagingPreflightDeps,
} from "../../../dist/lib/onboard/sandbox-messaging-preflight";
import { listChannels } from "../../../dist/lib/sandbox/channels";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function createResult(overrides = {}) {
  return {
    disabledChannelNames: new Set<string>(),
    messagingTokenDefs: [],
    extraPlaceholderKeys: [],
    hasMessagingTokens: false,
    reusableMessagingProviders: [],
    reusableMessagingChannels: [],
    missingBraveApiKey: false,
    ...overrides,
  };
}

function planChannel(channelId: string) {
  return {
    channelId,
    displayName: channelId,
    authMode: "token-paste" as const,
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks:
      channelId === "slack"
        ? [
            {
              channelId: "slack",
              id: "slack-socket-mode-gateway-conflict",
              phase: "pre-enable",
              handler: "slack.socketModeGatewayConflict",
              onFailure: "abort",
            },
          ]
        : [],
  };
}

function credentialBinding(channelId: string, envKey: string, sandboxName: string, hash?: string) {
  return {
    channelId,
    credentialId: `${channelId}Token`,
    sourceInput: "token",
    providerName: `${sandboxName}-${channelId}-bridge`,
    providerEnvKey: envKey,
    placeholder: `openshell:resolve:env:${envKey}`,
    credentialAvailable: true,
    ...(hash !== undefined ? { credentialHash: hash } : {}),
  };
}

function createPlan(
  sandboxName = "demo",
  channelId = "telegram",
  hash: string | undefined = "hash",
): NonNullable<ReturnType<SandboxMessagingPreflightDeps["readMessagingPlanFromEnv"]>> {
  const envKey =
    channelId === "slack"
      ? "SLACK_BOT_TOKEN"
      : channelId === "discord"
        ? "DISCORD_BOT_TOKEN"
        : "TELEGRAM_BOT_TOKEN";
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [planChannel(channelId)],
    disabledChannels: [],
    credentialBindings:
      channelId === "slack"
        ? [
            credentialBinding("slack", "SLACK_BOT_TOKEN", sandboxName, `${hash ?? "missing"}-bot`),
            credentialBinding("slack", "SLACK_APP_TOKEN", sandboxName, `${hash ?? "missing"}-app`),
          ]
        : [credentialBinding(channelId, envKey, sandboxName, hash)],
    networkPolicy: { presets: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  } as unknown as NonNullable<
    ReturnType<SandboxMessagingPreflightDeps["readMessagingPlanFromEnv"]>
  >;
}

function createDeps(
  overrides: Partial<SandboxMessagingPreflightDeps> = {},
): SandboxMessagingPreflightDeps {
  return {
    readMessagingPlanFromEnv: vi.fn(() => null),
    resolveDisabledChannels: vi.fn(() => []),
    gatewayName: "nemoclaw",
    registry: {
      listSandboxes: vi.fn(() => ({ sandboxes: [] })),
    },
    providerExistsInGateway: vi.fn(() => false),
    isNonInteractive: vi.fn(() => false),
    promptYesNoOrDefault: vi.fn(async () => true),
    cliName: vi.fn(() => "nemoclaw"),
    log: vi.fn(),
    error: vi.fn(),
    exitProcess: vi.fn((code: number) => {
      throw new ExitError(code);
    }) as (code: number) => never,
    getValidatedMessagingTokenByEnvKey: vi.fn(() => null),
    getCredential: vi.fn(() => null),
    normalizeCredentialValue: vi.fn((value: unknown) =>
      typeof value === "string" ? value.trim() : "",
    ),
    registerExtraPlaceholderProviders: vi.fn(() => []),
    getMessagingChannelForEnvKey: vi.fn(() => null),
    prepareCreateSandboxMessaging: vi.fn((input) =>
      createResult({ disabledChannelNames: new Set(input.disabledChannels) }),
    ),
    ...overrides,
  };
}

const baseInput = {
  sandboxName: "demo",
  channels: listChannels(),
  enabledChannels: ["slack"],
  webSearchConfig: null,
  env: {},
};

describe("prepareSandboxMessagingPreflight", () => {
  it("passes resolved disabled channels into messaging prep", async () => {
    const deps = createDeps({
      resolveDisabledChannels: vi.fn(() => ["telegram"]),
    });

    const result = await prepareSandboxMessagingPreflight(baseInput, deps);

    expect([...result.disabledChannelNames]).toEqual(["telegram"]);
    expect(result.disabledChannels).toEqual(["telegram"]);
    expect(deps.prepareCreateSandboxMessaging).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "demo",
        enabledChannels: ["slack"],
        disabledChannels: ["telegram"],
      }),
    );
  });

  it("ignores stale env plans for a different sandbox", async () => {
    const enforceMessagingChannelConflicts = vi.fn(async () => undefined);
    const deps = createDeps({
      readMessagingPlanFromEnv: vi.fn(() => createPlan("other")),
      enforceMessagingChannelConflicts,
    });

    await prepareSandboxMessagingPreflight(baseInput, deps);

    expect(enforceMessagingChannelConflicts).not.toHaveBeenCalled();
    expect(deps.prepareCreateSandboxMessaging).toHaveBeenCalled();
  });

  it("lets interactive users continue through a matching-token conflict", async () => {
    const deps = createDeps({
      readMessagingPlanFromEnv: vi.fn(() => createPlan("demo", "telegram", "same")),
      registry: {
        listSandboxes: vi.fn(() => ({
          sandboxes: [
            { name: "other", messaging: { plan: createPlan("other", "telegram", "same") } },
          ],
        })),
      },
      promptYesNoOrDefault: vi.fn(async () => true),
    });

    await prepareSandboxMessagingPreflight(baseInput, deps);

    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("uses the same telegram credential"),
    );
    expect(deps.promptYesNoOrDefault).toHaveBeenCalledWith("  Continue anyway?", null, false);
    expect(deps.prepareCreateSandboxMessaging).toHaveBeenCalled();
  });

  it("aborts non-interactive runs when the current plan conflicts", async () => {
    const deps = createDeps({
      readMessagingPlanFromEnv: vi.fn(() => createPlan("demo", "discord", undefined)),
      isNonInteractive: vi.fn(() => true),
      registry: {
        listSandboxes: vi.fn(() => ({
          sandboxes: [
            { name: "other", messaging: { plan: createPlan("other", "discord", undefined) } },
          ],
        })),
      },
    });

    await expect(prepareSandboxMessagingPreflight(baseInput, deps)).rejects.toMatchObject({
      code: 1,
    });
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("channels stop <channel>"));
    expect(deps.promptYesNoOrDefault).not.toHaveBeenCalled();
  });

  it("aborts a second Slack Socket Mode sandbox on the same gateway", async () => {
    const deps = createDeps({
      readMessagingPlanFromEnv: vi.fn(() => createPlan("demo", "slack", "demo")),
      isNonInteractive: vi.fn(() => true),
      registry: {
        listSandboxes: vi.fn(() => ({
          sandboxes: [
            {
              name: "other",
              gatewayName: "nemoclaw",
              messaging: { plan: createPlan("other", "slack", "other") },
            },
          ],
        })),
      },
    });

    await expect(prepareSandboxMessagingPreflight(baseInput, deps)).rejects.toMatchObject({
      code: 1,
    });
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("Slack Socket Mode is already enabled for sandbox 'other'"),
    );
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining("resolve the messaging pre-enable conflict above"),
    );
  });

  it("fails before recreate/delete when Brave search has no API key", async () => {
    const deps = createDeps({
      prepareCreateSandboxMessaging: vi.fn(() => createResult({ missingBraveApiKey: true })),
    });

    await expect(prepareSandboxMessagingPreflight(baseInput, deps)).rejects.toMatchObject({
      code: 1,
    });
    expect(deps.error).toHaveBeenCalledWith(
      "  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.",
    );
  });
});
