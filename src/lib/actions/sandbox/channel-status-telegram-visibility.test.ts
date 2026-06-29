// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../../policy", () => ({
  getAppliedPresets: vi.fn(() => []),
  getGatewayPresets: vi.fn(() => null),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: vi.fn(),
  getConfiguredMessagingChannelsFromEntry: vi.fn((entry) => {
    const channels = entry?.messaging?.plan?.channels;
    return Array.isArray(channels)
      ? channels
          .filter((channel) => channel?.configured === true)
          .map((channel) => channel.channelId)
      : [];
  }),
  getDisabledMessagingChannelsFromEntry: vi.fn((entry) => {
    const disabled = entry?.messaging?.plan?.disabledChannels;
    return Array.isArray(disabled) ? [...disabled] : [];
  }),
}));

vi.mock("../../agent/defs", () => ({
  loadAgent: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxExecCommand: vi.fn(),
}));

import { compileTelegramPlanForTests } from "../../messaging/__test-utils__/telegram-plan";
import type { MessagingSerializableValue, SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxEntry } from "../../state/registry";
import {
  channelStatusEntry,
  compactTelegramEntryFromEnv,
  makeChannelStatusDeps,
  useRealMessagingPlanReader,
} from "./__test-utils__";
import { showSandboxChannelStatus } from "./channel-status";

const PROBED_AT = new Date("2026-05-28T04:00:00.000Z");

const TELEGRAM_GROUP_POLICY_LABEL = {
  open: "open groups",
  allowlist: "allowlisted groups only",
  disabled: "groups disabled",
} as const;

function deps(opts: Parameters<typeof makeChannelStatusDeps>[0]) {
  return makeChannelStatusDeps(opts, PROBED_AT);
}

describe("showSandboxChannelStatus (telegram config visibility)", () => {
  for (const policy of ["open", "allowlist", "disabled"] as const) {
    it(`surfaces the resolved Telegram group policy: ${policy}`, async () => {
      const harness = deps({
        exec: () => ({ status: 0, stdout: "", stderr: "" }),
        sandbox: channelStatusEntry(["telegram"]),
        appliedPresets: ["telegram"],
        channelInputs: {
          telegram: [{ inputId: "groupPolicy", value: policy }],
        },
      });
      await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
      const dump = harness.out_lines.join("\n");
      const label = TELEGRAM_GROUP_POLICY_LABEL[policy];
      expect(dump).toMatch(
        new RegExp(`Telegram group policy:\\s+${label} \\(TELEGRAM_GROUP_POLICY=${policy}\\)`),
      );
      expect(dump).not.toMatch(/Telegram group policy:.*\(default\)/);
    });
  }

  it("falls back to the manifest default when no group policy value is persisted", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    expect(harness.out_lines.join("\n")).toMatch(
      /Telegram group policy:\s+open groups \(default\)/,
    );
  });

  it("surfaces the resolved Telegram mention mode alongside the group policy", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
      channelInputs: {
        telegram: [
          { inputId: "requireMention", value: "0" },
          { inputId: "groupPolicy", value: "allowlist" },
        ],
      },
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).toMatch(
      /Telegram group mention mode:\s+all group messages \(TELEGRAM_REQUIRE_MENTION=0\)/,
    );
    expect(dump).toMatch(
      /Telegram group policy:\s+allowlisted groups only \(TELEGRAM_GROUP_POLICY=allowlist\)/,
    );
  });

  it("translates Telegram requireMention=1 to the mention-only behavior label", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
      channelInputs: {
        telegram: [{ inputId: "requireMention", value: "1" }],
      },
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    expect(harness.out_lines.join("\n")).toMatch(
      /Telegram group mention mode:\s+mention-only \(TELEGRAM_REQUIRE_MENTION=1\)/,
    );
  });

  it("renders the mention-mode default with the mapped behavior label", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    expect(harness.out_lines.join("\n")).toMatch(
      /Telegram group mention mode:\s+mention-only \(default\)/,
    );
  });

  it("omits visible config defaults when the telegram channel is not registered", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry([]),
      appliedPresets: [],
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).not.toMatch(/Telegram group policy/);
    expect(dump).not.toMatch(/Telegram group mention mode/);
  });

  it("omits visible config defaults when the telegram channel is paused", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"], ["telegram"]),
      appliedPresets: ["telegram"],
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).not.toMatch(/Telegram group policy/);
    expect(dump).not.toMatch(/Telegram group mention mode/);
  });

  it("skips visible config inputs that have neither a persisted value nor a default", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    expect(harness.out_lines.join("\n")).not.toMatch(/Telegram User ID/);
  });

  it("hides the OpenClaw-only group policy when the sandbox runs Hermes", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
      agentName: "hermes",
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).not.toMatch(/Telegram group policy/);
    expect(dump).toMatch(/Telegram group mention mode:\s+mention-only \(default\)/);
  });

  it("redacts an invalid persisted value rather than echoing it", async () => {
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
      channelInputs: {
        telegram: [{ inputId: "groupPolicy", value: "definitely-not-a-policy" }],
      },
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).not.toMatch(/definitely-not-a-policy/);
    expect(dump).toMatch(
      /Telegram group policy:\s+invalid persisted value \(expected: open \| allowlist \| disabled\)/,
    );
  });

  it("redacts a non-scalar persisted Telegram value rather than echoing raw JSON", async () => {
    const tamperedObject = { allow: ["@one", "@two"], smuggled: "secret-id" };
    const tamperedArray = ["1", "0"];
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
      channelInputs: {
        telegram: [
          {
            inputId: "groupPolicy",
            value: tamperedObject as unknown as MessagingSerializableValue,
          },
          {
            inputId: "requireMention",
            value: tamperedArray as unknown as MessagingSerializableValue,
          },
        ],
      },
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).toMatch(/Telegram group policy:\s+invalid persisted value \(unsupported type\)/);
    expect(dump).toMatch(
      /Telegram group mention mode:\s+invalid persisted value \(unsupported type\)/,
    );
    expect(dump).not.toMatch(/secret-id/);
    expect(dump).not.toMatch(/smuggled/);
    expect(dump).not.toMatch(/@one/);
    expect(dump).not.toMatch(/"1"/);
  });

  it("renders Telegram inputs from a plan compiled out of process env through the command path", async () => {
    const plan = await compileTelegramPlanForTests({
      envOverrides: {
        TELEGRAM_GROUP_POLICY: "allowlist",
        TELEGRAM_REQUIRE_MENTION: undefined,
      },
    });
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: channelStatusEntry(["telegram"]),
      appliedPresets: ["telegram"],
      messagingPlan: plan,
    });
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).toMatch(
      /Telegram group policy:\s+allowlisted groups only \(TELEGRAM_GROUP_POLICY=allowlist\)/,
    );
    expect(dump).not.toMatch(/Telegram group policy:.*\(default\)/);
    expect(dump).toMatch(
      /Telegram group mention mode:\s+mention-only \(TELEGRAM_REQUIRE_MENTION=1\)/,
    );
  });

  it("reads Telegram visible config from a non-interactive compact registry entry through the real plan reader", async () => {
    const { entry: compactEntry } = await compactTelegramEntryFromEnv({
      envOverrides: { TELEGRAM_GROUP_POLICY: "disabled", TELEGRAM_REQUIRE_MENTION: "0" },
      isInteractive: false,
    });
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: compactEntry,
      appliedPresets: ["telegram"],
    });
    useRealMessagingPlanReader(
      harness.deps as {
        getMessagingPlan: (entry: SandboxEntry | undefined) => SandboxMessagingPlan | null;
      },
    );
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).toMatch(
      /Telegram group policy:\s+groups disabled \(TELEGRAM_GROUP_POLICY=disabled\)/,
    );
    expect(dump).toMatch(
      /Telegram group mention mode:\s+all group messages \(TELEGRAM_REQUIRE_MENTION=0\)/,
    );
    expect(dump).not.toMatch(/Telegram group policy:.*\(default\)/);
  });

  it("renders mention-only when a non-interactive compact registry entry omits TELEGRAM_REQUIRE_MENTION", async () => {
    const { entry: compactEntry } = await compactTelegramEntryFromEnv({
      envOverrides: { TELEGRAM_GROUP_POLICY: undefined, TELEGRAM_REQUIRE_MENTION: undefined },
      isInteractive: false,
    });
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: compactEntry,
      appliedPresets: ["telegram"],
    });
    useRealMessagingPlanReader(
      harness.deps as {
        getMessagingPlan: (entry: SandboxEntry | undefined) => SandboxMessagingPlan | null;
      },
    );
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).toMatch(
      /Telegram group mention mode:\s+mention-only \(TELEGRAM_REQUIRE_MENTION=1\)/,
    );
    expect(dump).not.toMatch(/Telegram group mention mode:.*all group messages/);
  });

  it("bounds tampered out-of-allowlist Telegram visible config from a compact registry entry through the real plan reader", async () => {
    const { entry: tamperedEntry } = await compactTelegramEntryFromEnv({
      envOverrides: { TELEGRAM_GROUP_POLICY: "allowlist", TELEGRAM_REQUIRE_MENTION: "0" },
      isInteractive: false,
      tamperedInputs: { groupPolicy: "definitely-not-a-policy", requireMention: "" },
    });
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: tamperedEntry,
      appliedPresets: ["telegram"],
    });
    useRealMessagingPlanReader(
      harness.deps as {
        getMessagingPlan: (entry: SandboxEntry | undefined) => SandboxMessagingPlan | null;
      },
    );
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).toMatch(
      /Telegram group policy:\s+invalid persisted value \(expected: open \| allowlist \| disabled\)/,
    );
    expect(dump).toMatch(
      /Telegram group mention mode:\s+invalid persisted value \(expected: 0 \| 1\)/,
    );
    expect(dump).not.toMatch(/definitely-not-a-policy/);
  });

  it("redacts non-scalar Telegram visible config from a compact registry entry through the real plan reader", async () => {
    const { entry: tamperedEntry } = await compactTelegramEntryFromEnv({
      envOverrides: { TELEGRAM_GROUP_POLICY: "allowlist", TELEGRAM_REQUIRE_MENTION: "0" },
      isInteractive: false,
      tamperedInputs: {
        groupPolicy: { smuggled: "secret-id" } as unknown,
        requireMention: ["1", "0"] as unknown,
      },
    });
    const harness = deps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: tamperedEntry,
      appliedPresets: ["telegram"],
    });
    useRealMessagingPlanReader(
      harness.deps as {
        getMessagingPlan: (entry: SandboxEntry | undefined) => SandboxMessagingPlan | null;
      },
    );
    await showSandboxChannelStatus("alpha", { deps: harness.deps, channel: "telegram" });
    const dump = harness.out_lines.join("\n");
    expect(dump).toMatch(/Telegram group policy:\s+invalid persisted value \(unsupported type\)/);
    expect(dump).toMatch(
      /Telegram group mention mode:\s+invalid persisted value \(unsupported type\)/,
    );
    expect(dump).not.toMatch(/secret-id/);
    expect(dump).not.toMatch(/smuggled/);
  });
});
