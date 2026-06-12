// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../channels";
import { createBuiltInMessagingHookRegistry, MessagingHookRegistry } from "../hooks";
import { MessagingWorkflowPlanner } from "./workflow-planner";

const TEST_CREDENTIALS: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN: "123456:test-telegram-token",
  DISCORD_BOT_TOKEN: "test-discord-token",
  WECHAT_BOT_TOKEN: "test-wechat-token",
  SLACK_BOT_TOKEN: "xoxb-test-slack-token",
  SLACK_APP_TOKEN: "xapp-test-slack-token",
};
const TEST_WECHAT_LOGIN = {
  token: "test-wechat-token",
  accountId: "test-wechat-account",
  baseUrl: "https://ilinkai.wechat.com",
  userId: "test-wechat-user",
} as const;

function planner(): MessagingWorkflowPlanner {
  return new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        env: {},
        getCredential: (key) => TEST_CREDENTIALS[key] ?? null,
        saveCredential: () => {},
        prompt: async () => "unused",
        log: () => {},
      },
      slack: {
        validateCredentials: {
          log: () => {},
          validateCredentials: () => ({ ok: true }),
        },
      },
      telegram: {
        fetch: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { ok: true };
          },
          async text() {
            return "";
          },
        }),
      },
      wechat: {
        ilinkLogin: {
          env: {},
          saveCredential: () => {},
          log: () => {},
          runLogin: async () => ({
            kind: "ok",
            credentials: TEST_WECHAT_LOGIN,
          }),
        },
        seedOpenClawAccount: {
          now: () => "2026-01-01T00:00:00.000Z",
        },
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
}

function findFunctionPaths(value: unknown, prefix = "$"): string[] {
  if (typeof value === "function") return [prefix];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findFunctionPaths(entry, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      findFunctionPaths(entry, `${prefix}.${key}`),
    );
  }
  return [];
}

async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("MessagingWorkflowPlanner", () => {
  it("builds onboard plans from configured channels", async () => {
    const plan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: true,
      configuredChannels: ["wechat", "telegram"],
    });

    expect(plan.workflow).toBe("onboard");
    expect(plan.disabledChannels).toEqual([]);
    expect(plan.channels.map((channel) => channel.channelId)).toEqual(["telegram", "wechat"]);
    expect(plan.channels).toEqual([
      expect.objectContaining({
        channelId: "telegram",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
      }),
      expect.objectContaining({
        channelId: "wechat",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
      }),
    ]);
    expect(
      plan.channels
        .find((channel) => channel.channelId === "wechat")
        ?.inputs.find((input) => input.inputId === "accountId"),
    ).toMatchObject({
      kind: "config",
      value: "test-wechat-account",
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "wechat",
    ]);
  });

  it("builds add-channel plans from caller-owned channel state", async () => {
    const plan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "add-channel",
      isInteractive: true,
      configuredChannels: ["telegram", "slack"],
      disabledChannels: ["telegram"],
    });

    expect(plan.workflow).toBe("add-channel");
    expect(plan.disabledChannels).toEqual(["telegram"]);
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
      selected: true,
    });
    expect(plan.channels.find((channel) => channel.channelId === "slack")).toMatchObject({
      configured: true,
      disabled: false,
      active: true,
      selected: true,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "slack",
    ]);
  });

  it("runs add-channel enrollment only for active configured channels", async () => {
    const hooks = new MessagingHookRegistry([
      {
        id: "common.tokenPaste",
        handler: (context) => {
          if (context.channelId === "telegram") {
            throw new Error("existing channels should not re-enroll");
          }
          const outputs: Record<string, { kind: "secret"; value: string }> = {};
          for (const output of context.outputDeclarations ?? []) {
            if (output.kind === "secret") {
              const value =
                context.channelId === "slack" && output.id === "botToken"
                  ? "xoxb-test-slack-bot-token"
                  : context.channelId === "slack" && output.id === "appToken"
                    ? "xapp-test-slack-app-token"
                    : `test-${context.channelId}-${output.id}`;
              outputs[output.id] = {
                kind: "secret",
                value,
              };
            }
          }
          return { outputs };
        },
      },
      {
        id: "common.configPrompt",
        handler: () => ({ outputs: {} }),
      },
      {
        id: "slack.validateCredentials",
        handler: () => ({}),
      },
    ]);
    const plan = await new MessagingWorkflowPlanner(
      createBuiltInChannelManifestRegistry(),
      hooks,
      createBuiltInRenderTemplateResolver(),
    ).buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "add-channel",
      isInteractive: true,
      configuredChannels: ["telegram", "slack"],
      disabledChannels: ["telegram"],
    });

    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      active: false,
      selected: true,
    });
    expect(
      plan.channels
        .find((channel) => channel.channelId === "slack")
        ?.inputs.filter((input) => input.kind === "secret")
        .every((input) => input.credentialAvailable === true),
    ).toBe(true);
  });

  it("does not re-run host-QR enrollment when required manifest inputs are already available", async () => {
    const hooks = new MessagingHookRegistry([
      {
        id: "wechat.ilinkLogin",
        handler: () => {
          throw new Error("cached host-QR inputs should not re-enroll");
        },
      },
      {
        id: "common.configPrompt",
        handler: () => ({ outputs: {} }),
      },
      {
        id: "slack.validateCredentials",
        handler: () => ({}),
      },
      {
        id: "wechat.seedOpenClawAccount",
        handler: () => ({
          outputs: {
            openclawWeixinAccountsIndex: {
              kind: "build-file",
              value: { path: "openclaw-weixin/accounts.json", content: [] },
            },
            openclawWeixinAccountFile: {
              kind: "build-file",
              value: { path: "openclaw-weixin/accounts/cached-wechat-account.json", content: {} },
            },
            openclawConfigPatch: {
              kind: "build-file",
              value: { path: "openclaw.json", merge: {} },
            },
          },
        }),
      },
    ]);

    await withEnv(
      {
        WECHAT_ACCOUNT_ID: "cached-wechat-account",
        WECHAT_ALLOWED_IDS: "cached-wechat-user",
      },
      async () => {
        const plan = await new MessagingWorkflowPlanner(
          createBuiltInChannelManifestRegistry(),
          hooks,
          createBuiltInRenderTemplateResolver(),
        ).buildPlan({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "onboard",
          isInteractive: true,
          configuredChannels: ["wechat"],
          credentialAvailability: {
            WECHAT_BOT_TOKEN: true,
          },
        });

        expect(plan.channels[0]).toMatchObject({
          channelId: "wechat",
          active: true,
          selected: true,
          configured: true,
        });
        expect(plan.channels[0]?.inputs).toContainEqual(
          expect.objectContaining({
            inputId: "accountId",
            value: "cached-wechat-account",
          }),
        );
      },
    );
  });

  it("records disabled configured channels for stop-channel plans", async () => {
    const plan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "stop-channel",
      isInteractive: false,
      configuredChannels: ["telegram", "slack"],
      disabledChannels: ["telegram"],
      credentialAvailability: {
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(plan.workflow).toBe("stop-channel");
    expect(plan.disabledChannels).toEqual(["telegram"]);
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
      selected: true,
    });
    expect(plan.channels.find((channel) => channel.channelId === "slack")).toMatchObject({
      configured: true,
      disabled: false,
      active: true,
      selected: true,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "slack",
    ]);
    expect(plan.credentialBindings.some((binding) => binding.channelId === "telegram")).toBe(true);
  });

  it("records re-enabled channels for start-channel plans", async () => {
    const plan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "start-channel",
      isInteractive: false,
      configuredChannels: ["telegram", "slack"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(plan.workflow).toBe("start-channel");
    expect(plan.disabledChannels).toEqual([]);
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      configured: true,
      disabled: false,
      active: true,
      selected: true,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "slack",
    ]);
  });

  it("builds remove-channel plans from the post-removal configured state", async () => {
    const plan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "remove-channel",
      isInteractive: false,
      configuredChannels: ["wechat", "slack"],
      disabledChannels: ["wechat"],
      credentialAvailability: {
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(plan.workflow).toBe("remove-channel");
    expect(plan.disabledChannels).toEqual(["wechat"]);
    expect(plan.channels.map((channel) => channel.channelId)).toEqual(["wechat", "slack"]);
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toBeUndefined();
    expect(plan.channels.find((channel) => channel.channelId === "wechat")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["wechat", "slack"]);
  });

  it("builds rebuild plans from configured and disabled registry snapshots", async () => {
    const plan = await withEnv(
      {
        WECHAT_ACCOUNT_ID: "test-wechat-account",
      },
      () =>
        planner().buildPlan({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "rebuild",
          isInteractive: false,
          configuredChannels: ["telegram", "discord", "wechat"],
          disabledChannels: ["discord"],
          credentialAvailability: {
            TELEGRAM_BOT_TOKEN: true,
            WECHAT_BOT_TOKEN: true,
          },
        }),
    );

    expect(plan.workflow).toBe("rebuild");
    expect(plan.disabledChannels).toEqual(["discord"]);
    expect(plan.channels.map((channel) => channel.channelId)).toEqual([
      "telegram",
      "discord",
      "wechat",
    ]);
    expect(plan.channels.find((channel) => channel.channelId === "discord")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
      selected: true,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "discord",
      "wechat",
    ]);
  });

  it("refreshes missing manifest render entries from stale rebuild plans", async () => {
    const existingPlan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "hermes",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["discord"],
      credentialAvailability: {
        DISCORD_BOT_TOKEN: true,
      },
    });
    const stalePlan = {
      ...existingPlan,
      credentialBindings: existingPlan.credentialBindings.map((binding) => ({
        ...binding,
        credentialHash: "hash-discord-token",
      })),
      agentRender: [],
      buildSteps: [],
    };

    const plan = await planner().buildRebuildPlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "hermes",
      sandboxEntry: {
        name: "demo",
        agent: "hermes",
        messaging: { schemaVersion: 1, plan: stalePlan },
      },
      supportedChannelIds: ["discord"],
    });

    expect(plan?.workflow).toBe("rebuild");
    expect(
      plan?.credentialBindings.find((binding) => binding.providerEnvKey === "DISCORD_BOT_TOKEN")
        ?.credentialHash,
    ).toBe("hash-discord-token");
    const discordEnvRender = plan?.agentRender.find(
      (entry) =>
        entry.channelId === "discord" &&
        entry.kind === "env-lines" &&
        entry.target === "~/.hermes/.env",
    );
    expect(discordEnvRender).toMatchObject({
      kind: "env-lines",
      lines: expect.arrayContaining(["DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN"]),
    });
  });

  it("adds one manifest channel into an existing sandbox entry plan", async () => {
    const existingPlan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["telegram"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
      },
    });
    const hooks = new MessagingHookRegistry([
      {
        id: "common.tokenPaste",
        handler: (context) => {
          if (context.channelId === "telegram") {
            throw new Error("existing channels should not re-enroll");
          }
          const outputs: Record<string, { kind: "secret"; value: string }> = {};
          for (const output of context.outputDeclarations ?? []) {
            if (output.kind === "secret") {
              const value =
                context.channelId === "slack" && output.id === "botToken"
                  ? "xoxb-test-slack-bot-token"
                  : context.channelId === "slack" && output.id === "appToken"
                    ? "xapp-test-slack-app-token"
                    : `test-${context.channelId}-${output.id}`;
              outputs[output.id] = {
                kind: "secret",
                value,
              };
            }
          }
          return { outputs };
        },
      },
      {
        id: "common.configPrompt",
        handler: () => ({ outputs: {} }),
      },
      {
        id: "slack.validateCredentials",
        handler: () => ({}),
      },
    ]);

    const plan = await new MessagingWorkflowPlanner(
      createBuiltInChannelManifestRegistry(),
      hooks,
      createBuiltInRenderTemplateResolver(),
    ).buildChannelAddPlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "openclaw",
      sandboxEntry: {
        name: "demo",
        messaging: {
          schemaVersion: 1,
          plan: existingPlan,
        },
      },
      channelId: "slack",
      isInteractive: true,
      supportedChannelIds: ["telegram", "slack"],
    });

    expect(plan.workflow).toBe("add-channel");
    expect(plan.channels.map((channel) => channel.channelId)).toEqual(["telegram", "slack"]);
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      active: true,
      configured: true,
    });
    expect(plan.channels.find((channel) => channel.channelId === "slack")).toMatchObject({
      active: true,
      configured: true,
      disabled: false,
    });
    expect(plan.credentialBindings.map((binding) => binding.channelId)).toEqual([
      "telegram",
      "slack",
      "slack",
    ]);
  });

  it("mutates disabled channel state in an existing sandbox entry plan", async () => {
    const existingPlan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["telegram", "slack"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    const stopped = await planner().buildChannelStopPlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "openclaw",
      sandboxEntry: {
        name: "demo",
        messaging: {
          schemaVersion: 1,
          plan: existingPlan,
        },
      },
      channelId: "telegram",
    });

    expect(stopped?.workflow).toBe("stop-channel");
    expect(stopped?.disabledChannels).toEqual(["telegram"]);
    expect(stopped?.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      active: false,
      disabled: true,
    });

    const started = await planner().buildChannelStartPlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "openclaw",
      sandboxEntry: {
        name: "demo",
        messaging: {
          schemaVersion: 1,
          plan: stopped!,
        },
      },
      channelId: "telegram",
    });

    expect(started?.workflow).toBe("start-channel");
    expect(started?.disabledChannels).toEqual([]);
    expect(started?.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      active: true,
      disabled: false,
    });
  });

  it("removes a channel and its dependent plan entries from an existing sandbox entry plan", async () => {
    const existingPlan = await planner().buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["telegram", "slack"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    const removed = await planner().buildChannelRemovePlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "openclaw",
      sandboxEntry: {
        name: "demo",
        messaging: {
          schemaVersion: 1,
          plan: existingPlan,
        },
      },
      channelId: "telegram",
    });

    expect(removed?.workflow).toBe("remove-channel");
    expect(removed?.channels.map((channel) => channel.channelId)).toEqual(["slack"]);
    expect(removed?.disabledChannels).toEqual([]);
    expect(removed?.credentialBindings.some((binding) => binding.channelId === "telegram")).toBe(
      false,
    );
    expect(removed?.networkPolicy.entries.some((entry) => entry.channelId === "telegram")).toBe(
      false,
    );
    expect(removed?.agentRender.some((entry) => entry.channelId === "telegram")).toBe(false);
  });

  it("rebuilds from stored plan input values when config env is unavailable", async () => {
    const existingPlan = await withEnv(
      {
        TELEGRAM_REQUIRE_MENTION: "1",
      },
      () =>
        planner().buildPlan({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "onboard",
          isInteractive: false,
          configuredChannels: ["telegram"],
          credentialAvailability: {
            TELEGRAM_BOT_TOKEN: true,
          },
        }),
    );

    await withEnv(
      {
        TELEGRAM_REQUIRE_MENTION: undefined,
      },
      async () => {
        const rebuilt = await planner().buildRebuildPlanFromSandboxEntry({
          sandboxName: "demo",
          agent: "openclaw",
          sandboxEntry: {
            name: "demo",
            messaging: {
              schemaVersion: 1,
              plan: existingPlan,
            },
          },
        });

        expect(rebuilt?.workflow).toBe("rebuild");
        expect(
          rebuilt?.channels
            .find((channel) => channel.channelId === "telegram")
            ?.inputs.find((input) => input.inputId === "requireMention"),
        ).toMatchObject({
          value: "1",
        });
        expect(rebuilt?.channels.find((channel) => channel.channelId === "telegram")).toMatchObject(
          {
            active: true,
            disabled: false,
          },
        );
      },
    );
  });

  it("does not compile a rebuild plan when the sandbox entry has no stored plan or channels", async () => {
    const rebuilt = await planner().buildRebuildPlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "openclaw",
      sandboxEntry: {
        name: "demo",
      },
    });

    expect(rebuilt).toBeNull();
  });

  it("reports unsupported channels deterministically before compiling", async () => {
    await expect(
      planner().buildPlan({
        sandboxName: "demo",
        agent: "openclaw",
        workflow: "onboard",
        isInteractive: false,
        configuredChannels: ["slack", "discord"],
        supportedChannelIds: ["telegram"],
      }),
    ).rejects.toThrow("Unsupported messaging channel(s) for openclaw: discord, slack");
  });

  it("returns serializable, secret-free plans suitable for dry-run and shadow output", async () => {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "123456:raw-telegram-token",
      },
      async () => {
        const plan = await planner().buildPlan({
          sandboxName: "demo",
          agent: "openclaw",
          workflow: "add-channel",
          isInteractive: false,
          configuredChannels: ["telegram"],
        });
        const serialized = JSON.stringify(plan);

        expect(JSON.parse(serialized)).toEqual(plan);
        expect(findFunctionPaths(plan)).toEqual([]);
        expect(serialized).toContain("openshell:resolve:env:TELEGRAM_BOT_TOKEN");
        expect(serialized).not.toContain("123456:raw-telegram-token");
      },
    );
  });
});
