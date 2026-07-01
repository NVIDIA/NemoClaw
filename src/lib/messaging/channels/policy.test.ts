// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  listBuiltInMessagingChannelManifests,
  listMessagingPolicyPresetMetadata,
} from "./metadata";

type PolicyFixture = {
  readonly channelId: string;
  readonly presetName: string;
};

function fixtureContentFor(
  file: string,
  filesByChannel: Readonly<Record<string, string>>,
): string | null {
  const normalized = file.replaceAll("\\", "/");
  return (
    Object.entries(filesByChannel).find(([channelId]) =>
      normalized.endsWith(`/src/lib/messaging/channels/${channelId}/policy/openclaw.yaml`),
    )?.[1] ?? null
  );
}

async function importPolicy(): Promise<typeof import("./policy")> {
  vi.resetModules();
  return import("./policy");
}

async function importPolicyWithFixtures(
  presets: readonly PolicyFixture[],
  filesByChannel: Readonly<Record<string, string>> = {},
): Promise<typeof import("./policy")> {
  vi.resetModules();
  vi.doMock("./metadata", () => ({
    listMessagingPolicyPresetMetadata: vi.fn(() => presets),
  }));
  vi.doMock("node:fs", () => ({
    default: {
      existsSync: vi.fn((file: string) => fixtureContentFor(file, filesByChannel) !== null),
      readFileSync: vi.fn((file: string) => fixtureContentFor(file, filesByChannel) ?? ""),
    },
  }));
  return import("./policy");
}

afterEach(() => {
  vi.doUnmock("./metadata");
  vi.doUnmock("node:fs");
  vi.resetModules();
});

function policyKeys(content: string | null): string[] {
  expect(content).toBeTruthy();
  const parsed = YAML.parse(content ?? "");
  return Object.keys(parsed?.network_policies ?? {});
}

describe("messaging channel policy presets", () => {
  it("loads OpenClaw and Hermes channel-specific Telegram policy keys", async () => {
    const policy = await importPolicy();
    expect(
      policyKeys(policy.loadMessagingChannelPolicyPreset("telegram", { agent: "openclaw" })),
    ).toEqual(["telegram_bot"]);
    expect(
      policyKeys(policy.loadMessagingChannelPolicyPreset("telegram", { agent: "hermes" })),
    ).toEqual(["telegram"]);
  });

  it("lists operator-facing preset names from channel-owned policy files", async () => {
    const policy = await importPolicy();
    const presets = policy.listMessagingChannelPolicyPresets();
    expect(presets.map((preset) => preset.name).sort()).toEqual([
      "discord",
      "slack",
      "teams",
      "telegram",
      "wechat",
      "whatsapp",
    ]);
    expect(presets.find((preset) => preset.name === "slack")?.file).toBe(
      "src/lib/messaging/channels/slack/policy/openclaw.yaml",
    );
  });

  it("does not fall back to OpenClaw policies for unsupported agents", async () => {
    const policy = await importPolicy();
    expect(
      policy.loadMessagingChannelPolicyPreset("telegram", {
        agent: "langchain-deepagents-code",
      }),
    ).toBeNull();
    expect(
      policy.resolveMessagingChannelPolicyPresetPath("telegram", "langchain-deepagents-code"),
    ).toBeNull();
    expect(
      policy.listMessagingChannelPolicyPresets({ agent: "langchain-deepagents-code" }),
    ).toEqual([]);
  });

  it("returns null for unknown channel policy presets", async () => {
    const policy = await importPolicy();
    expect(policy.loadMessagingChannelPolicyPreset("nonexistent", { agent: "hermes" })).toBeNull();
    expect(policy.resolveMessagingChannelPolicyPresetPath("nonexistent", "hermes")).toBeNull();
  });

  it("rejects path traversal channel ids from preset metadata", async () => {
    const policy = await importPolicyWithFixtures([
      { channelId: "../telegram", presetName: "telegram" },
    ]);
    expect(policy.resolveMessagingChannelPolicyPresetPath("telegram")).toBeNull();
    expect(policy.loadMessagingChannelPolicyPreset("telegram")).toBeNull();
  });

  it("returns null when channel policy files are missing", async () => {
    const policy = await importPolicyWithFixtures([{ channelId: "missing", presetName: "slack" }]);
    expect(policy.resolveMessagingChannelPolicyPresetPath("slack")).toBeNull();
    expect(policy.loadMessagingChannelPolicyPreset("slack")).toBeNull();
  });

  it("skips channel policy files whose preset header has the wrong name", async () => {
    const policy = await importPolicyWithFixtures([{ channelId: "slack", presetName: "slack" }], {
      slack: "preset:\n  name: discord\nnetwork_policies:\n  discord: {}\n",
    });
    expect(policy.loadMessagingChannelPolicyPreset("slack")).toBeNull();
    expect(policy.listMessagingChannelPolicyPresets()).toEqual([]);
  });

  it("returns null for malformed channel policy YAML", async () => {
    const policy = await importPolicyWithFixtures([{ channelId: "slack", presetName: "slack" }], {
      slack: "preset:\n  name: [\nnetwork_policies:\n  slack: {}\n",
    });
    expect(policy.loadMessagingChannelPolicyPreset("slack")).toBeNull();
    expect(policy.listMessagingChannelPolicyPresets()).toEqual([]);
  });

  it("ships a policy file for every manifest-supported agent and preset", async () => {
    const policy = await importPolicy();
    const missing = listBuiltInMessagingChannelManifests().flatMap((manifest) =>
      manifest.supportedAgents.flatMap((agent) =>
        listMessagingPolicyPresetMetadata({ manifests: [manifest], agent }).flatMap((preset) =>
          policy.resolveMessagingChannelPolicyPresetPath(preset.presetName, agent)
            ? []
            : [`${manifest.id}/${agent}/${preset.presetName}`],
        ),
      ),
    );
    expect(missing).toEqual([]);
  });
});
