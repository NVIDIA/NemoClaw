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

  it("ships a policy file for every manifest-supported agent and preset", () => {
    const missing: string[] = [];
    for (const manifest of listBuiltInMessagingChannelManifests()) {
      for (const agent of manifest.supportedAgents) {
        for (const preset of listMessagingPolicyPresetMetadata({ manifests: [manifest], agent })) {
          const resolved = resolveMessagingChannelPolicyPresetPath(preset.presetName, agent);
          if (!resolved) missing.push(`${manifest.id}/${agent}/${preset.presetName}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
