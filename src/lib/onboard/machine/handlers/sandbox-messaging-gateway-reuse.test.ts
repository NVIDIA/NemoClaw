// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wechatManifest } from "../../../messaging/channels/built-ins";
import type {
  ChannelAuthMode,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingPlan,
} from "../../../messaging/manifest";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../../messaging/provider-profile";
import { hashCredential } from "../../../security/credential-hash";
import type { GatewayCredentialOnlyProviderInspection } from "../../gateway-provider-metadata";
import { reconcileSandboxMessaging } from "./sandbox-messaging";

function lifecyclePlan(
  channelId: SandboxMessagingPlan["channels"][number]["channelId"],
  displayName: string,
  authMode: ChannelAuthMode,
  credentialBindings: readonly SandboxMessagingCredentialBindingPlan[],
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "start-channel",
    channels: [
      {
        channelId,
        displayName,
        authMode,
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings,
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function gatewayReuseDeps(plan: SandboxMessagingPlan) {
  return {
    note: vi.fn(),
    showMessagingStage: vi.fn(),
    getRecordedMessagingChannelsForResume: vi.fn((): string[] | null => null),
    setupMessagingChannels: vi.fn(async () => []),
    readMessagingPlanFromEnv: vi.fn((): SandboxMessagingPlan | null => null),
    writePlanToEnv: vi.fn(),
    clearPlanEnv: vi.fn(),
    getRegistrySandboxMessagingAuthority: vi.fn(() => ({ authoritative: true as const, plan })),
    inspectGatewayCredential: vi.fn<
      (name: string, type: string, credentialEnv: string) => GatewayCredentialOnlyProviderInspection
    >(() => ({ kind: "exact" })),
    providerMatchesGatewayCredential: vi.fn(() => false),
  };
}

function slackBinding(
  credentialId: "slackBotToken" | "slackAppToken",
  providerName: string,
  providerEnvKey: "SLACK_BOT_TOKEN" | "SLACK_APP_TOKEN",
): SandboxMessagingCredentialBindingPlan {
  return {
    channelId: "slack",
    credentialId,
    sourceInput: credentialId === "slackBotToken" ? "botToken" : "appToken",
    providerName,
    providerEnvKey,
    placeholder: `openshell:resolve:env:${providerEnvKey}`,
    credentialAvailable: true,
    credentialHash: hashCredential(`previous-${providerEnvKey.toLowerCase()}`) ?? "",
  };
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe("gateway-backed messaging lifecycle reuse", () => {
  it("keeps WeChat selected for start/rebuild when the gateway retains its QR token (#10765)", async () => {
    const credential = wechatManifest.credentials[0];
    const nodePreloads = wechatManifest.runtime.openclaw.nodePreloads ?? [];
    const plan: SandboxMessagingPlan = {
      ...lifecyclePlan(wechatManifest.id, wechatManifest.displayName, wechatManifest.auth.mode, [
        {
          channelId: wechatManifest.id,
          credentialId: credential.id,
          sourceInput: credential.sourceInput,
          providerName: credential.providerName.replaceAll("{sandboxName}", "alpha"),
          providerEnvKey: credential.providerEnvKey,
          placeholder: credential.placeholder,
          credentialAvailable: true,
          credentialHash: hashCredential("previous-wechat-token") ?? "",
        },
      ]),
      runtimeSetup: {
        nodePreloads: nodePreloads.map((preload) => ({
          ...preload,
          channelId: wechatManifest.id,
          source: "manifest",
          target: "agent",
        })),
        envAliases: [],
        secretScans: [],
      },
    };
    const deps = gatewayReuseDeps(plan);
    vi.stubEnv("WECHAT_BOT_TOKEN", "");
    vi.stubEnv("WECHAT_ACCOUNT_ID", "");

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(result.selectedChannels).toEqual(["wechat"]);
    expect(result.plan?.runtimeSetup?.nodePreloads.map(({ module }) => module)).toContain(
      "wechat-account-placeholder",
    );
    expect(deps.inspectGatewayCredential).toHaveBeenCalledWith(
      "alpha-wechat-bridge",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "WECHAT_BOT_TOKEN",
    );
    expect(deps.note).not.toHaveBeenCalledWith(expect.stringContaining("disabling the channel"));
  });

  it("migrates legacy Slack bindings before start/rebuild gateway probes", async () => {
    const currentBindings = [
      slackBinding("slackBotToken", "alpha-slack-bridge", "SLACK_BOT_TOKEN"),
      slackBinding("slackAppToken", "alpha-slack-app", "SLACK_APP_TOKEN"),
    ];
    const legacyPlan = lifecyclePlan("slack", "Slack", "token-paste", [
      currentBindings[0],
      { ...currentBindings[1], providerName: "alpha-slack-bridge" },
    ]);
    const expectedPlan = { ...legacyPlan, credentialBindings: currentBindings };
    const deps = gatewayReuseDeps(legacyPlan);
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(result).toEqual({ plan: expectedPlan, selectedChannels: ["slack"] });
    expect(deps.inspectGatewayCredential).toHaveBeenCalledWith(
      "alpha-slack-bridge",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "SLACK_BOT_TOKEN",
    );
    expect(deps.inspectGatewayCredential).toHaveBeenCalledWith(
      "alpha-slack-app",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "SLACK_APP_TOKEN",
    );
    expect(deps.inspectGatewayCredential).not.toHaveBeenCalledWith(
      "alpha-slack-bridge",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "SLACK_APP_TOKEN",
    );
    expect(deps.writePlanToEnv).toHaveBeenLastCalledWith(expectedPlan);
  });
});
