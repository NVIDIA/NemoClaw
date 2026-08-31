// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  listBuiltInMessagingChannelManifests,
  listMessagingPolicyPresetMetadata,
} from "./metadata";
import {
  createMessagingChannelPolicyResolver,
  listMessagingChannelPolicyPresets,
  loadMessagingChannelPolicyPreset,
  materializeMessagingPolicySandboxName,
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

  it("returns policy content unchanged when it has no sandbox placeholder", () => {
    const content = "preset:\n  name: discord\nnetwork_policies:\n  discord: {}\n";
    const policy = createPolicyWithFixtures([{ channelId: "discord", presetName: "discord" }], {
      discord: content,
    });

    expect(
      policy.loadMessagingChannelPolicyPreset("discord", { sandboxName: "test-sandbox" }),
    ).toBe(content);
  });

  it("rejects policy content with an unresolved sandbox placeholder", () => {
    const content = [
      "preset:",
      "  name: discord",
      "network_policies:",
      "  discord:",
      "    credential_binding:",
      '      provider: "{sandboxName}-discord-bridge"',
      "",
    ].join("\n");
    const policy = createPolicyWithFixtures([{ channelId: "discord", presetName: "discord" }], {
      discord: content,
    });

    expect(policy.loadMessagingChannelPolicyPreset("discord")).toBeNull();
  });

  it.each([undefined, null, "bad:provider"])(
    "does not materialize a sandbox provider binding from %s",
    (sandboxName) => {
      expect(
        materializeMessagingPolicySandboxName(
          'credential_binding:\n  provider: "{sandboxName}-discord-bridge"\n',
          sandboxName,
        ),
      ).toBeNull();
    },
  );

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

  it.each(["openclaw", "hermes"] as const)(
    "authorizes one exact validated WeChat IDC endpoint with its credential binding on %s (#10606)",
    (agent) => {
      const content = loadMessagingChannelPolicyPreset("wechat", {
        agent,
        sandboxName: `${agent}-wechat`,
        messagingConfig: { WECHAT_BASE_URL: "https://idc-37.weixin.qq.com" },
      });
      const endpoints = YAML.parse(content ?? "").network_policies.wechat_bridge.endpoints;
      const configured = endpoints.find(
        (endpoint: { host: string }) => endpoint.host === "idc-37.weixin.qq.com",
      );

      expect(configured).toEqual({
        host: "idc-37.weixin.qq.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        credential_binding: { provider: `${agent}-wechat-wechat-bridge` },
        rules: [
          { allow: { method: "GET", path: "/**" } },
          { allow: { method: "POST", path: "/**" } },
        ],
      });
      expect(
        endpoints.filter((endpoint: { host: string }) => endpoint.host.startsWith("idc-")),
      ).toHaveLength(1);
      expect(endpoints.map((endpoint: { host: string }) => endpoint.host)).not.toContain(
        "*.weixin.qq.com",
      );
    },
  );

  it.each([
    "http://idc-3.weixin.qq.com",
    "https://idc-3.weixin.qq.com:443",
    "https://idc-3.weixin.qq.com:8443",
    "https://user@idc-3.weixin.qq.com",
    "https://idc-3.weixin.qq.com/path",
    "https://idc-3.weixin.qq.com?query=1",
    "https://idc-3.weixin.qq.com#fragment",
    "https://*.weixin.qq.com",
    "https://idc-3.weixin.qq.com.evil.example",
    "https://evil.example",
  ])("rejects an untrusted WeChat policy origin [case %#] (#10606)", (baseUrl) => {
    expect(() =>
      loadMessagingChannelPolicyPreset("wechat", {
        agent: "openclaw",
        sandboxName: "wechat-policy-test",
        messagingConfig: { WECHAT_BASE_URL: baseUrl },
      }),
    ).toThrow(/WeChat baseUrl/);
  });

  it("fails closed when a configured endpoint loses its reviewed template (#10606)", () => {
    const policy = createPolicyWithFixtures([{ channelId: "wechat", presetName: "wechat" }], {
      wechat: "preset:\n  name: wechat\nnetwork_policies:\n  wechat_bridge:\n    endpoints: []\n",
    });

    expect(() =>
      policy.loadMessagingChannelPolicyPreset("wechat", {
        messagingConfig: { WECHAT_BASE_URL: "https://idc-3.weixin.qq.com" },
      }),
    ).toThrow("reviewed template 'ilinkai.wechat.com' is missing");
  });
});
