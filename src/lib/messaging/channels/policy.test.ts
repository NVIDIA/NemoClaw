// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  listBuiltInMessagingChannelManifests,
  listMessagingPolicyPresetMetadata,
} from "./metadata";
import {
  createMessagingChannelPolicyResolver,
  listMessagingChannelPolicyPresets,
  loadMessagingChannelPolicyPreset,
  resolveMessagingChannelPolicyPresetPath,
} from "./policy";

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

function createPolicyWithFixtures(
  presets: readonly PolicyFixture[],
  filesByChannel: Readonly<Record<string, string>> = {},
): ReturnType<typeof createMessagingChannelPolicyResolver> {
  return createMessagingChannelPolicyResolver({
    existsSync: (file) => fixtureContentFor(file, filesByChannel) !== null,
    readFileSync: (file) => fixtureContentFor(file, filesByChannel) ?? "",
    listPresetMetadata: () => presets,
  });
}

describe("messaging channel policy presets", () => {
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

  it("rejects path traversal channel ids from preset metadata", () => {
    const policy = createPolicyWithFixtures([{ channelId: "../telegram", presetName: "telegram" }]);
    expect(policy.resolveMessagingChannelPolicyPresetPath("telegram")).toBeNull();
    expect(policy.loadMessagingChannelPolicyPreset("telegram")).toBeNull();
  });

  it("returns null when channel policy files are missing", () => {
    const policy = createPolicyWithFixtures([{ channelId: "missing", presetName: "slack" }]);
    expect(policy.resolveMessagingChannelPolicyPresetPath("slack")).toBeNull();
    expect(policy.loadMessagingChannelPolicyPreset("slack")).toBeNull();
  });

  it("skips channel policy files whose preset header has the wrong name", () => {
    const policy = createPolicyWithFixtures([{ channelId: "slack", presetName: "slack" }], {
      slack: "preset:\n  name: discord\nnetwork_policies:\n  discord: {}\n",
    });
    expect(policy.loadMessagingChannelPolicyPreset("slack")).toBeNull();
    expect(policy.listMessagingChannelPolicyPresets()).toEqual([]);
  });

  it("returns null for malformed channel policy YAML", () => {
    const policy = createPolicyWithFixtures([{ channelId: "slack", presetName: "slack" }], {
      slack: "preset:\n  name: [\nnetwork_policies:\n  slack: {}\n",
    });
    expect(policy.loadMessagingChannelPolicyPreset("slack")).toBeNull();
    expect(policy.listMessagingChannelPolicyPresets()).toEqual([]);
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
