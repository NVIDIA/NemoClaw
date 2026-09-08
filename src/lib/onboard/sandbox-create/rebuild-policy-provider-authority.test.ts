// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  compactSandboxMessagingPlanForPersistence,
  createBuiltInChannelManifestRegistry,
  createBuiltInMessagingHookRegistry,
  createBuiltInRenderTemplateResolver,
  loadMessagingChannelPolicyPreset,
  MessagingWorkflowPlanner,
  type SandboxMessagingPlan,
} from "../../messaging";
import type { Session } from "../../state/onboard-session";
import {
  getMessagingChannelConfigFromPlan,
  getStoredMessagingChannelConfig,
} from "../messaging-config";

import {
  bindRebuildPolicyProvidersToCreateArgs,
  resolveRebuildMessagingPolicyDeltas,
  resolveRebuildObservabilityPolicyDelta,
  resolveRebuildPolicyProviderAuthority,
  selectRebuildCreatePolicy,
} from "./orchestration";

const tempRoots: string[] = [];

function tempPolicy(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-rebuild-policy-test-"));
  tempRoots.push(root);
  const policyPath = path.join(root, "policy.yaml");
  fs.writeFileSync(policyPath, source, { mode: 0o600 });
  return policyPath;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("rebuild policy provider handoff", () => {
  const preservedMcpState = {
    bridges: {
      github: {
        server: "github",
        agent: "openclaw",
        url: "https://mcp.example.com/",
        env: ["MCP_TOKEN"],
        providerName: "alpha-mcp-github",
        providerId: "provider-id",
        policyName: "mcp_github",
        addedAt: "2026-08-30T00:00:00.000Z",
      },
    },
  };

  it("derives active additions and disabled removals from current channel manifests", () => {
    expect(
      resolveRebuildMessagingPolicyDeltas({
        agent: "hermes",
        disabledChannels: ["telegram", "googlechat"],
        networkPolicy: {
          presets: ["wechat"],
          entries: [
            {
              channelId: "telegram",
              presetName: "telegram",
              policyKeys: ["telegram"],
              source: "agent-alias",
            },
            {
              channelId: "wechat",
              presetName: "wechat",
              policyKeys: ["wechat_bridge"],
              source: "manifest",
            },
          ],
        },
      }),
    ).toEqual({
      requiredNetworkPolicyKeys: ["wechat_bridge"],
      requiredNetworkPolicyPresetNames: ["wechat"],
      removedNetworkPolicyKeys: ["telegram", "googlechat_hermes"],
    });
  });

  it.each(["openclaw", "hermes"] as const)(
    "preserves the QR-captured exact WeChat IDC endpoint through %s persistence and rebuild (#10606)",
    async (agent) => {
      const sandboxName = `rebuild-${agent}`;
      const legacyWechatPolicy = loadMessagingChannelPolicyPreset("wechat", {
        agent,
        sandboxName,
      });
      assert(legacyWechatPolicy);
      const livePolicyPath = tempPolicy(legacyWechatPolicy);
      const planner = new MessagingWorkflowPlanner(
        createBuiltInChannelManifestRegistry(),
        createBuiltInMessagingHookRegistry({
          common: {
            env: {},
            getCredential: () => null,
            saveCredential: () => {},
            prompt: async () => "unused",
            log: () => {},
          },
          wechat: {
            ilinkLogin: {
              env: {},
              saveCredential: () => {},
              log: () => {},
              runLogin: async () => ({
                kind: "ok",
                credentials: {
                  token: "test-wechat-token",
                  accountId: "test-wechat-account",
                  baseUrl: "https://idc-37.weixin.qq.com",
                  userId: "test-wechat-user",
                },
              }),
            },
            seedOpenClawAccount: { now: () => "2026-08-31T00:00:00.000Z" },
          },
        }),
        createBuiltInRenderTemplateResolver(),
      );
      const enrolled = await planner.buildPlan({
        sandboxName,
        agent,
        workflow: "onboard",
        isInteractive: true,
        configuredChannels: ["wechat"],
      });
      const persisted = compactSandboxMessagingPlanForPersistence(enrolled);
      const persistedBaseUrl = persisted.channels[0]?.inputs?.find(
        ({ inputId }) => inputId === "baseUrl",
      );

      expect(persistedBaseUrl?.value).toBe("https://idc-37.weixin.qq.com");
      expect(persisted).not.toHaveProperty("networkPolicy");

      const messagingPlan = await planner.buildRebuildPlanFromSandboxEntry({
        sandboxName,
        agent,
        sandboxEntry: {
          name: sandboxName,
          agent,
          messaging: {
            schemaVersion: 1,
            plan: persisted as unknown as SandboxMessagingPlan,
          },
        },
      });
      expect(messagingPlan).not.toBeNull();
      const providerName = messagingPlan?.credentialBindings.find(
        ({ channelId }) => channelId === "wechat",
      )?.providerName;
      expect(providerName).toBe(`${sandboxName}-wechat-bridge`);
      assert(providerName);

      const deltas = resolveRebuildMessagingPolicyDeltas(messagingPlan!);
      const rebuilt = selectRebuildCreatePolicy(
        livePolicyPath,
        {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [providerName],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        deltas.requiredNetworkPolicyKeys,
        deltas.removedNetworkPolicyKeys,
        deltas.requiredNetworkPolicyPresetNames,
        messagingPlan!.agent,
        getMessagingChannelConfigFromPlan(messagingPlan),
        sandboxName,
        [providerName],
      );

      try {
        const policy = YAML.parse(rebuilt.sourceBytes?.toString("utf8") ?? "") as {
          network_policies: {
            wechat_bridge: {
              endpoints: Array<{
                host: string;
                credential_binding: { provider: string };
              }>;
              binaries: Array<{ path: string }>;
            };
          };
        };
        const endpoints = policy.network_policies.wechat_bridge.endpoints;
        const configured = endpoints.find(({ host }) => host === "idc-37.weixin.qq.com");

        expect(configured).toMatchObject({
          host: "idc-37.weixin.qq.com",
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          credential_binding: { provider: providerName },
          rules: [
            { allow: { method: "GET", path: "/**" } },
            { allow: { method: "POST", path: "/**" } },
          ],
        });
        expect(endpoints.filter(({ host }) => host.startsWith("idc-"))).toHaveLength(1);
        expect(endpoints.map(({ host }) => host)).not.toContain("*.weixin.qq.com");
        expect(policy.network_policies.wechat_bridge.binaries.map(({ path }) => path)).toContain(
          agent === "hermes" ? "/usr/local/bin/hermes" : "/usr/local/bin/node",
        );
      } finally {
        rebuilt.cleanup?.();
      }
    },
  );

  it.each(["openclaw", "hermes"] as const)(
    "upgrades a legacy session-only WeChat policy and keeps its provider attached for %s (#10606)",
    (agent) => {
      const sandboxName = agent === "hermes" ? "legacy-he" : "legacy-oc";
      const providerName = `${sandboxName}-wechat-bridge`;
      const legacyWechatPolicy = loadMessagingChannelPolicyPreset("wechat", {
        agent,
        sandboxName,
      });
      assert(legacyWechatPolicy);
      const livePolicyPath = tempPolicy(legacyWechatPolicy);
      const legacyMessagingConfig = getStoredMessagingChannelConfig(
        sandboxName,
        {
          sandboxName,
          messagingPlan: null,
          wechatConfig: {
            accountId: "legacy-account",
            baseUrl: "https://idc-3.weixin.qq.com",
            userId: "legacy-user",
          },
        } as Session,
        {
          readMessagingPlanFromEnv: () => null,
          getRegistryMessagingAuthority: () => ({ authoritative: false, plan: null }),
        },
      );
      expect(legacyMessagingConfig?.WECHAT_BASE_URL).toBe("https://idc-3.weixin.qq.com");
      expect(() =>
        resolveRebuildMessagingPolicyDeltas(null, {
          agent,
          messagingConfig: {
            WECHAT_BASE_URL: "https://idc-3.weixin.qq.com.evil.example",
          },
        }),
      ).toThrow("WeChat baseUrl must use an expected iLink host");
      const replacementWechatPolicy = loadMessagingChannelPolicyPreset("wechat", {
        agent,
        sandboxName,
        messagingConfig: legacyMessagingConfig,
      });
      assert(replacementWechatPolicy);

      const deltas = resolveRebuildMessagingPolicyDeltas(null, {
        agent,
        messagingConfig: legacyMessagingConfig,
      });
      expect(deltas).toEqual({
        requiredNetworkPolicyKeys: ["wechat_bridge"],
        requiredNetworkPolicyPresetNames: ["wechat"],
        removedNetworkPolicyKeys: [],
      });
      const rebuilt = selectRebuildCreatePolicy(
        livePolicyPath,
        {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [providerName],
          sourceBytes: Buffer.from(replacementWechatPolicy),
        },
        deltas.requiredNetworkPolicyKeys,
        deltas.removedNetworkPolicyKeys,
        deltas.requiredNetworkPolicyPresetNames,
        agent,
        legacyMessagingConfig,
        sandboxName,
        [providerName],
      );

      try {
        const policy = YAML.parse(rebuilt.sourceBytes?.toString("utf8") ?? "") as {
          network_policies: {
            wechat_bridge: {
              endpoints: Array<{
                host: string;
                credential_binding: { provider: string };
              }>;
            };
          };
        };
        const endpoints = policy.network_policies.wechat_bridge.endpoints;
        expect(endpoints.find(({ host }) => host === "idc-3.weixin.qq.com")).toMatchObject({
          port: 443,
          protocol: "rest",
          enforcement: "enforce",
          credential_binding: { provider: providerName },
          rules: [
            { allow: { method: "GET", path: "/**" } },
            { allow: { method: "POST", path: "/**" } },
          ],
        });
        expect(endpoints.filter(({ host }) => host.startsWith("idc-"))).toHaveLength(1);
        expect(endpoints.map(({ host }) => host)).not.toContain("*.weixin.qq.com");

        expect(bindRebuildPolicyProvidersToCreateArgs(["--from", "image"], rebuilt)).toEqual([
          "--from",
          "image",
          "--provider",
          providerName,
        ]);
      } finally {
        rebuilt.cleanup?.();
      }
    },
  );

  it.each([
    ["langchain-deepagents-code", true, true, "balanced", ["observability-otlp-local"], []],
    ["langchain-deepagents-code", false, true, "balanced", [], ["observability-otlp-local"]],
    ["langchain-deepagents-code", true, true, "restricted", [], ["observability-otlp-local"]],
    ["langchain-deepagents-code", true, false, null, [], []],
    ["openclaw", true, true, "balanced", [], []],
  ] as const)(
    "derives the rebuild observability delta for %s enabled=%s explicit=%s tier=%s",
    (
      agent,
      enabled,
      explicitlyRequested,
      tierName,
      requiredNetworkPolicyKeys,
      removedNetworkPolicyKeys,
    ) => {
      expect(
        resolveRebuildObservabilityPolicyDelta({
          agent,
          enabled,
          explicitlyRequested,
          tierName,
        }),
      ).toEqual({ requiredNetworkPolicyKeys, removedNetworkPolicyKeys });
    },
  );

  it("adds missing live-policy providers to the final create arguments", () => {
    expect(
      bindRebuildPolicyProvidersToCreateArgs(
        ["--from", "image", "--provider", "operator-provider"],
        {
          credentialBindingProviders: ["operator-provider", "wechat-provider"],
        },
      ),
    ).toEqual([
      "--from",
      "image",
      "--provider",
      "operator-provider",
      "--provider",
      "wechat-provider",
    ]);
  });

  it("inserts rebuild providers before the sandbox startup command separator", () => {
    expect(
      bindRebuildPolicyProvidersToCreateArgs(
        [
          "openshell",
          "sandbox",
          "create",
          "--provider",
          "inference-provider",
          "--",
          "env",
          "nemoclaw-start",
        ],
        {
          credentialBindingProviders: ["inference-provider", "mcp-provider"],
        },
      ),
    ).toEqual([
      "openshell",
      "sandbox",
      "create",
      "--provider",
      "inference-provider",
      "--provider",
      "mcp-provider",
      "--",
      "env",
      "nemoclaw-start",
    ]);
  });

  it("authorizes enabled messaging and managed MCP providers but rejects disabled channels", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: ["--from", "image", "--provider", "inference-provider"],
        messagingPlan: {
          disabledChannels: ["discord"],
          credentialBindings: [
            {
              channelId: "telegram",
              credentialId: "bot-token",
              sourceInput: "token",
              providerName: "alpha-telegram-bridge",
              providerEnvKey: "TELEGRAM_BOT_TOKEN",
              placeholder: "${TELEGRAM_BOT_TOKEN}",
              credentialAvailable: true,
            },
            {
              channelId: "discord",
              credentialId: "bot-token",
              sourceInput: "token",
              providerName: "alpha-discord-bridge",
              providerEnvKey: "DISCORD_BOT_TOKEN",
              placeholder: "${DISCORD_BOT_TOKEN}",
              credentialAvailable: true,
            },
          ],
        },
        preservedMcpState,
        managedMcpRebuildHandoff: true,
      }),
    ).toEqual(["inference-provider", "alpha-telegram-bridge", "alpha-mcp-github"]);
  });

  it("does not authorize MCP registry names without the managed rebuild handoff", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: [],
        messagingPlan: null,
        preservedMcpState,
        managedMcpRebuildHandoff: false,
      }),
    ).toEqual([]);
  });

  it("ignores incomplete MCP add records even with a managed rebuild handoff", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: [],
        messagingPlan: null,
        preservedMcpState: {
          bridges: {
            github: {
              ...preservedMcpState.bridges.github,
              addState: "prepared",
            },
          },
        },
        managedMcpRebuildHandoff: true,
      }),
    ).toEqual([]);
  });
});
