// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createBuiltInChannelManifestRegistry } from "../channels";
import { FAKE_TELEGRAM_HOOK_REGISTRATIONS } from "../channels/telegram/hooks/fakes";
import { FAKE_WECHAT_HOOK_REGISTRATIONS } from "../channels/wechat/hooks/fakes";
import { MessagingHookRegistry } from "../hooks";
import { FAKE_COMMON_HOOK_REGISTRATIONS } from "../hooks/common";
import { MessagingWorkflowPlanner } from "./workflow-planner";

function planner(): MessagingWorkflowPlanner {
  return new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    new MessagingHookRegistry([
      ...FAKE_COMMON_HOOK_REGISTRATIONS,
      ...FAKE_TELEGRAM_HOOK_REGISTRATIONS,
      ...FAKE_WECHAT_HOOK_REGISTRATIONS,
    ]),
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
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
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
  it("plans onboard as selected, configured, active channels with enrollment inputs", async () => {
    const plan = await planner().planOnboard({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: true,
      selectedChannels: ["wechat", "telegram"],
    });

    expect(plan.workflow).toBe("onboard");
    expect(plan.channels.map((channel) => channel.channelId)).toEqual([
      "telegram",
      "wechat",
    ]);
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
      value: "fake-wechat-account",
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "wechat",
    ]);
  });

  it("plans add-channel as a configured active target and clears stale disabled state", async () => {
    const plan = await planner().planAddChannel({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: true,
      channelId: "slack",
      configuredChannels: ["telegram"],
      disabledChannels: ["telegram", "slack"],
    });

    expect(plan.workflow).toBe("add-channel");
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
      selected: false,
    });
    expect(plan.channels.find((channel) => channel.channelId === "slack")).toMatchObject({
      configured: true,
      disabled: false,
      active: true,
      selected: true,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["slack"]);
  });

  it("runs add-channel enrollment only for the selected channel", async () => {
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
              outputs[output.id] = {
                kind: "secret",
                value: `fake-${context.channelId}-${output.id}`,
              };
            }
          }
          return { outputs };
        },
      },
    ]);
    const plan = await new MessagingWorkflowPlanner(
      createBuiltInChannelManifestRegistry(),
      hooks,
    ).planAddChannel({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: true,
      channelId: "slack",
      configuredChannels: ["telegram"],
    });

    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      active: true,
      selected: false,
    });
    expect(
      plan.channels
        .find((channel) => channel.channelId === "slack")
        ?.inputs.filter((input) => input.kind === "secret")
        .every((input) => input.credentialAvailable === true),
    ).toBe(true);
  });

  it("plans stop-channel by keeping configured state and disabling only that channel", async () => {
    const plan = await planner().planStopChannel({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: false,
      channelId: "telegram",
      configuredChannels: ["telegram", "slack"],
    });

    expect(plan.workflow).toBe("stop-channel");
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
      selected: false,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["slack"]);
    expect(
      plan.credentialBindings.some((binding) => binding.channelId === "telegram"),
    ).toBe(false);
  });

  it("plans start-channel by preserving configured state and making the channel active", async () => {
    const plan = await planner().planStartChannel({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: false,
      channelId: "telegram",
      configuredChannels: ["telegram", "slack"],
      disabledChannels: ["telegram"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(plan.workflow).toBe("start-channel");
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

  it("plans remove-channel by deleting configured and disabled state", async () => {
    const plan = await planner().planRemoveChannel({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: false,
      channelId: "telegram",
      configuredChannels: ["telegram", "wechat", "slack"],
      disabledChannels: ["telegram", "wechat"],
    });

    expect(plan.workflow).toBe("remove-channel");
    expect(plan.channels.map((channel) => channel.channelId)).toEqual(["wechat", "slack"]);
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toBeUndefined();
    expect(plan.channels.find((channel) => channel.channelId === "wechat")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["slack"]);
  });

  it("plans rebuild from configured and disabled registry snapshots", async () => {
    const plan = await planner().planRebuild({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: false,
      configuredChannels: ["telegram", "discord", "wechat"],
      disabledChannels: ["discord"],
    });

    expect(plan.workflow).toBe("rebuild");
    expect(plan.channels.map((channel) => channel.channelId)).toEqual([
      "telegram",
      "discord",
      "wechat",
    ]);
    expect(plan.channels.find((channel) => channel.channelId === "discord")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
      selected: false,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "wechat",
    ]);
  });

  it("reports unsupported channels deterministically before compiling", async () => {
    await expect(
      planner().planOnboard({
        sandboxName: "demo",
        agent: "openclaw",
        isInteractive: false,
        selectedChannels: ["slack", "discord"],
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
        const plan = await planner().planAddChannel({
          sandboxName: "demo",
          agent: "openclaw",
          isInteractive: false,
          channelId: "telegram",
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
