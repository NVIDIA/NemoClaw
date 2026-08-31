// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import type { SandboxMessagingPlan } from "../../messaging/manifest";

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
    "materializes the persisted exact WeChat IDC endpoint during %s rebuild (#10606)",
    (agent) => {
      const sandboxName = `rebuild-${agent}`;
      const livePolicyPath = tempPolicy("version: 1\nnetwork_policies: {}\n");
      const messagingPlan = {
        schemaVersion: 1,
        sandboxName,
        agent,
        workflow: "rebuild",
        channels: [
          {
            channelId: "wechat",
            displayName: "WeChat",
            authMode: "host-qr",
            active: true,
            selected: true,
            configured: true,
            disabled: false,
            inputs: [
              {
                channelId: "wechat",
                inputId: "baseUrl",
                kind: "config",
                required: false,
                sourceEnv: "WECHAT_BASE_URL",
                value: "https://idc-37.weixin.qq.com",
              },
            ],
            hooks: [],
          },
        ],
        disabledChannels: [],
        credentialBindings: [],
        networkPolicy: {
          presets: ["wechat"],
          entries: [
            {
              channelId: "wechat",
              presetName: "wechat",
              policyKeys: ["wechat_bridge"],
              source: "manifest",
            },
          ],
        },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      } satisfies SandboxMessagingPlan;
      const providerName = `${sandboxName}-wechat-bridge`;
      const rebuilt = selectRebuildCreatePolicy(
        livePolicyPath,
        {
          policyPath: livePolicyPath,
          appliedPresets: [],
          credentialBindingProviders: [providerName],
          sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
        },
        ["wechat_bridge"],
        [],
        ["wechat"],
        messagingPlan,
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

        expect(configured?.credential_binding.provider).toBe(providerName);
        expect(endpoints.map(({ host }) => host)).not.toContain("*.weixin.qq.com");
        expect(policy.network_policies.wechat_bridge.binaries.map(({ path }) => path)).toContain(
          agent === "hermes" ? "/usr/local/bin/hermes" : "/usr/local/bin/node",
        );
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
