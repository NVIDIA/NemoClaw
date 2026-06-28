// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getMessagingPlanFromEntry,
  serializeSandboxMessagingStateForDisk,
} from "../state/registry-messaging";
import { compileTelegramPlanForTests } from "./__test-utils__/telegram-plan";
import {
  collectBuiltInMessagingChannelDiagnostics,
  collectVisibleConfigRecords,
} from "./diagnostics";

describe("messaging channel diagnostics", () => {
  it("derives common channel diagnostic metadata directly from manifests", () => {
    const specs = collectBuiltInMessagingChannelDiagnostics();

    expect(specs.map((spec) => spec.channelId)).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
    ]);
    expect(specs.find((spec) => spec.channelId === "telegram")).toMatchObject({
      policyPresets: ["telegram"],
      preferredDefault: false,
    });
    expect(specs.find((spec) => spec.channelId === "wechat")).toMatchObject({
      policyPresets: ["wechat"],
    });
    expect(specs.find((spec) => spec.channelId === "whatsapp")).toMatchObject({
      policyPresets: ["whatsapp"],
      preferredDefault: true,
      deepProbe: "in-sandbox-qr",
      doctorWhenNoHealthSignals: expect.objectContaining({
        hint: "run `{cli} {sandbox} channels status --channel {channel}` to probe inbound delivery",
      }),
    });
    expect(specs.find((spec) => spec.channelId === "teams")).toMatchObject({
      policyPresets: ["teams"],
      preferredDefault: false,
    });
  });
});

describe("collectVisibleConfigRecords (compiled plan integration)", () => {
  it("renders Telegram visible config from a plan compiled out of process env, not from injected plan inputs", async () => {
    const plan = await compileTelegramPlanForTests({
      envOverrides: {
        TELEGRAM_GROUP_POLICY: "allowlist",
        TELEGRAM_REQUIRE_MENTION: undefined,
      },
    });

    const diagnostic = collectBuiltInMessagingChannelDiagnostics().find(
      (spec) => spec.channelId === "telegram",
    );
    expect(diagnostic).toBeDefined();

    const records = collectVisibleConfigRecords(diagnostic!, plan, "telegram", "openclaw");
    const labels = records.map((record) => record.input.label);
    const byLabel = (label: string) => records.find((record) => record.input.label === label);

    expect(labels).toContain("Telegram group policy");
    expect(labels).toContain("Telegram group mention mode");
    expect(byLabel("Telegram group policy")?.display).toMatchObject({
      source: "persisted",
      detail: "allowlisted groups only (TELEGRAM_GROUP_POLICY=allowlist)",
    });
    expect(byLabel("Telegram group mention mode")?.display).toMatchObject({
      source: "persisted",
      detail: "mention-only (TELEGRAM_REQUIRE_MENTION=1)",
    });
  });

  it("redacts non-scalar persisted Telegram visible config values without echoing raw JSON", async () => {
    const basePlan = await compileTelegramPlanForTests({
      envOverrides: {
        TELEGRAM_GROUP_POLICY: undefined,
        TELEGRAM_REQUIRE_MENTION: undefined,
      },
    });

    const tamperedPlan = {
      ...basePlan,
      channels: basePlan.channels.map((channel) =>
        channel.channelId === "telegram"
          ? {
              ...channel,
              inputs: [
                ...channel.inputs.filter(
                  (input) => input.inputId !== "groupPolicy" && input.inputId !== "requireMention",
                ),
                {
                  channelId: "telegram",
                  inputId: "groupPolicy",
                  kind: "config" as const,
                  required: false,
                  value: { tampered: ["allowlist", "open"] } as unknown as string,
                },
                {
                  channelId: "telegram",
                  inputId: "requireMention",
                  kind: "config" as const,
                  required: false,
                  value: ["1", "0"] as unknown as string,
                },
              ],
            }
          : channel,
      ),
    };

    const diagnostic = collectBuiltInMessagingChannelDiagnostics().find(
      (spec) => spec.channelId === "telegram",
    );
    expect(diagnostic).toBeDefined();

    const records = collectVisibleConfigRecords(diagnostic!, tamperedPlan, "telegram", "openclaw");
    const byLabel = (label: string) => records.find((record) => record.input.label === label);

    const policy = byLabel("Telegram group policy");
    expect(policy?.display).toMatchObject({
      source: "invalid",
      detail: "invalid persisted value (unsupported type)",
    });
    expect(policy?.display.detail).not.toMatch(/tampered/);
    expect(policy?.display.detail).not.toMatch(/allowlist/);

    const mention = byLabel("Telegram group mention mode");
    expect(mention?.display).toMatchObject({
      source: "invalid",
      detail: "invalid persisted value (unsupported type)",
    });
    expect(mention?.display.detail).not.toMatch(/\[/);
    expect(mention?.display.detail).not.toMatch(/"/);
  });

  it("never persists out-of-allowlist Telegram env values to the plan at the planner source boundary", async () => {
    const plan = await compileTelegramPlanForTests({
      envOverrides: {
        TELEGRAM_GROUP_POLICY: "definitely-not-a-policy",
        TELEGRAM_REQUIRE_MENTION: "definitely-not-a-mode",
      },
    });
    const telegramChannel = plan.channels.find((channel) => channel.channelId === "telegram");
    expect(telegramChannel).toBeDefined();
    const policyInput = telegramChannel?.inputs.find((input) => input.inputId === "groupPolicy");
    const mentionInput = telegramChannel?.inputs.find(
      (input) => input.inputId === "requireMention",
    );
    expect(policyInput?.value).not.toBe("definitely-not-a-policy");
    expect(mentionInput?.value).not.toBe("definitely-not-a-mode");
    const policyAllowed = ["open", "allowlist", "disabled", undefined] as const;
    const mentionAllowed = ["0", "1", undefined] as const;
    expect(policyAllowed).toContain(policyInput?.value as (typeof policyAllowed)[number]);
    expect(mentionAllowed).toContain(mentionInput?.value as (typeof mentionAllowed)[number]);

    const diagnostic = collectBuiltInMessagingChannelDiagnostics().find(
      (spec) => spec.channelId === "telegram",
    );
    const records = collectVisibleConfigRecords(diagnostic!, plan, "telegram", "openclaw");
    const byLabel = (label: string) => records.find((record) => record.input.label === label);
    expect(byLabel("Telegram group policy")?.display.detail).not.toMatch(/definitely-not-a-policy/);
    expect(byLabel("Telegram group mention mode")?.display.detail).not.toMatch(
      /definitely-not-a-mode/,
    );
  });

  it("preserves Telegram visible config through disk serialization and registry readback", async () => {
    const compiled = await compileTelegramPlanForTests({
      envOverrides: {
        TELEGRAM_GROUP_POLICY: "allowlist",
        TELEGRAM_REQUIRE_MENTION: "0",
      },
    });
    const onDisk = serializeSandboxMessagingStateForDisk({ schemaVersion: 1, plan: compiled });
    expect(onDisk).toBeDefined();
    const fakeEntry = { messaging: onDisk };
    const reloaded = getMessagingPlanFromEntry(fakeEntry);
    expect(reloaded).not.toBeNull();

    const diagnostic = collectBuiltInMessagingChannelDiagnostics().find(
      (spec) => spec.channelId === "telegram",
    );
    expect(diagnostic).toBeDefined();
    const records = collectVisibleConfigRecords(diagnostic!, reloaded, "telegram", "openclaw");
    const byLabel = (label: string) => records.find((record) => record.input.label === label);
    expect(byLabel("Telegram group policy")?.display).toMatchObject({
      source: "persisted",
      detail: "allowlisted groups only (TELEGRAM_GROUP_POLICY=allowlist)",
    });
    expect(byLabel("Telegram group mention mode")?.display).toMatchObject({
      source: "persisted",
      detail: "all group messages (TELEGRAM_REQUIRE_MENTION=0)",
    });
  });
});
