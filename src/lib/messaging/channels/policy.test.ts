// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  listBuiltInMessagingChannelManifests,
  listMessagingPolicyPresetMetadata,
} from "./metadata";
import {
  listMessagingChannelPolicyPresets,
  loadMessagingChannelPolicyPreset,
  resolveMessagingChannelPolicyPresetPath,
} from "./policy";

function policyKeys(content: string | null): string[] {
  expect(content).toBeTruthy();
  const parsed = YAML.parse(content ?? "");
  return Object.keys(parsed?.network_policies ?? {});
}

describe("messaging channel policy presets", () => {
  it("loads OpenClaw and Hermes channel-specific Telegram policy keys", () => {
    expect(policyKeys(loadMessagingChannelPolicyPreset("telegram", { agent: "openclaw" }))).toEqual(
      ["telegram_bot"],
    );
    expect(policyKeys(loadMessagingChannelPolicyPreset("telegram", { agent: "hermes" }))).toEqual([
      "telegram",
    ]);
  });

  it("lists operator-facing preset names from channel-owned policy files", () => {
    const presets = listMessagingChannelPolicyPresets();
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

  it("does not fall back to OpenClaw policies for unsupported agents", () => {
    expect(
      loadMessagingChannelPolicyPreset("telegram", { agent: "langchain-deepagents-code" }),
    ).toBeNull();
    expect(
      resolveMessagingChannelPolicyPresetPath("telegram", "langchain-deepagents-code"),
    ).toBeNull();
    expect(listMessagingChannelPolicyPresets({ agent: "langchain-deepagents-code" })).toEqual([]);
  });

  it("returns null for unknown channel policy presets", () => {
    expect(loadMessagingChannelPolicyPreset("nonexistent", { agent: "hermes" })).toBeNull();
    expect(resolveMessagingChannelPolicyPresetPath("nonexistent", "hermes")).toBeNull();
  });

  it("ships a policy file for every manifest-supported agent and preset", () => {
    const missing = listBuiltInMessagingChannelManifests().flatMap((manifest) =>
      manifest.supportedAgents.flatMap((agent) =>
        listMessagingPolicyPresetMetadata({ manifests: [manifest], agent }).flatMap((preset) =>
          resolveMessagingChannelPolicyPresetPath(preset.presetName, agent)
            ? []
            : [`${manifest.id}/${agent}/${preset.presetName}`],
        ),
      ),
    );
    expect(missing).toEqual([]);
  });
});
