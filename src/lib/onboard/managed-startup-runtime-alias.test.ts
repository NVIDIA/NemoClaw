// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { createBuiltInRenderTemplateResolver } from "../messaging/channels/index.ts";
import { teamsManifest } from "../messaging/channels/teams/manifest.ts";
import { wechatManifest } from "../messaging/channels/wechat/manifest.ts";
import { buildWechatSeedOpenClawAccountOutputs } from "../messaging/channels/wechat/hooks/seed-openclaw-account.ts";
import { planAgentRender } from "../messaging/compiler/engines/agent-render-engine.ts";
import {
  encodeManagedStartupProfile,
  type ManagedStartupJsonObject,
  type ManagedStartupJsonValue,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile.ts";

// Runtime env aliases remain part of the managed-startup contract and are still
// applied by agents/hermes/runtime-config-guard.py, but no shipped channel
// declares one any more: Slack's was retired once OpenShell 0.0.106 began
// binding SLACK_* to the policy endpoint, which rejects the Bolt-shaped alias.
// Keep a literal of the retired alias so the validator stays covered.
const slackBotAlias = {
  envKey: "SLACK_BOT_TOKEN",
  match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
  value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
  message:
    "[channels] Normalized SLACK_BOT_TOKEN runtime placeholder to the Bolt-compatible alias",
} as const;

function profileWithAliases(aliases: readonly ManagedStartupJsonObject[]): ManagedStartupProfile {
  const profile = managedStartupE2eProfile("hermes");
  return {
    ...profile,
    messaging: {
      plan: {
        schemaVersion: 1,
        agent: "hermes",
        runtimeSetup: {
          nodePreloads: [],
          envAliases: aliases.map((alias) => ({ channelId: "slack", ...alias })),
          secretScans: [],
        },
      },
    },
  };
}

function wechatAccountBuildStep(): ManagedStartupJsonObject {
  const hook = wechatManifest.hooks.find((entry) => entry.id === "wechat-seed-openclaw-account")!;
  const output = hook.outputs?.find((entry) => entry.id === "openclawWeixinAccountFile")!;
  const result = buildWechatSeedOpenClawAccountOutputs(
    {
      "wechatConfig.accountId": "wechat-account",
    },
    { now: () => "2026-08-18T00:00:00.000Z" },
  ).openclawWeixinAccountFile!;
  return {
    channelId: wechatManifest.id,
    kind: result.kind,
    hookId: hook.id,
    handler: hook.handler,
    outputId: output.id,
    required: output.required === true,
    value: result.value!,
  };
}

function profileWithBuildSteps(
  buildSteps: readonly ManagedStartupJsonObject[],
): ManagedStartupProfile {
  const profile = managedStartupE2eProfile("openclaw");
  return {
    ...profile,
    messaging: {
      plan: {
        schemaVersion: 1,
        agent: "openclaw",
        buildSteps,
      },
    },
  };
}

function profileWithAgentRender(
  agentRender: readonly ManagedStartupJsonObject[],
): ManagedStartupProfile {
  const profile = managedStartupE2eProfile("openclaw");
  return {
    ...profile,
    messaging: {
      plan: {
        schemaVersion: 1,
        agent: "openclaw",
        agentRender,
      },
    },
  };
}

async function teamsOpenClawChannelRender(): Promise<ManagedStartupJsonObject> {
  const renders = await planAgentRender(
    teamsManifest,
    {
      sandboxName: "managed-startup-test",
      agent: "openclaw",
      workflow: "rebuild",
      isInteractive: false,
      configuredChannels: ["teams"],
      credentialAvailability: { MSTEAMS_APP_PASSWORD: true },
    },
    [
      {
        channelId: "teams",
        inputId: "appId",
        kind: "config",
        required: true,
        statePath: "teamsConfig.appId",
        value: "test-app-id",
      },
      {
        channelId: "teams",
        inputId: "tenantId",
        kind: "config",
        required: true,
        statePath: "teamsConfig.tenantId",
        value: "test-tenant-id",
      },
      {
        channelId: "teams",
        inputId: "webhookPort",
        kind: "config",
        required: false,
        statePath: "teamsConfig.webhookPort",
        value: "3978",
      },
      {
        channelId: "teams",
        inputId: "requireMention",
        kind: "config",
        required: false,
        statePath: "teamsConfig.requireMention",
        value: "1",
      },
    ],
    undefined,
    createBuiltInRenderTemplateResolver(),
  );
  const render = renders.find((entry) => entry.renderId === "teams-openclaw-channel");
  expect(render).toBeDefined();
  return render as unknown as ManagedStartupJsonObject;
}

function withTeamsWebhook(
  render: ManagedStartupJsonObject,
  webhook: unknown,
): ManagedStartupJsonObject {
  return {
    ...render,
    value: {
      ...(render.value as ManagedStartupJsonObject),
      webhook: webhook as ManagedStartupJsonValue,
    },
  };
}

function expectProfileTransportAccepted(profile: ManagedStartupProfile): void {
  const validated = validateManagedStartupProfile(profile);
  expect(() => encodeManagedStartupProfile(validated)).not.toThrow();
}

function withWechatAccountToken(
  step: ManagedStartupJsonObject,
  token: string,
): ManagedStartupJsonObject {
  const value = step.value as ManagedStartupJsonObject;
  const content = value.content as ManagedStartupJsonObject;
  return { ...step, value: { ...value, content: { ...content, token } } };
}

describe("managed startup runtime aliases", () => {
  it("accepts a well-formed runtime alias (#9397)", () => {
    expect(() => validateManagedStartupProfile(profileWithAliases([slackBotAlias]))).not.toThrow();
  });

  it.each([
    ["an invalid environment key", { ...slackBotAlias, envKey: "BAD KEY" }],
    [
      "an unanchored resolver expression",
      { ...slackBotAlias, match: "openshell:resolve:env:SLACK_BOT_TOKEN" },
    ],
    [
      "a resolver expression for another key",
      {
        ...slackBotAlias,
        match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_APP_TOKEN$",
      },
    ],
    [
      "a placeholder for another key",
      { ...slackBotAlias, value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN" },
    ],
    ["a raw credential", { ...slackBotAlias, value: `xoxb-${"a".repeat(32)}` }],
  ])("rejects %s (#9397)", (_label, alias) => {
    expect(() => validateManagedStartupProfile(profileWithAliases([alias]))).toThrow(
      /credential-shaped string data/,
    );
  });

  it.each([slackBotAlias.match, slackBotAlias.value])(
    "rejects runtime alias data outside the schema-owned path (#9397)",
    (runtimeAliasData) => {
      const profile = profileWithAliases([]);
      expect(() =>
        validateManagedStartupProfile({
          ...profile,
          messaging: {
            plan: {
              ...profile.messaging.plan,
              note: runtimeAliasData,
            },
          },
        }),
      ).toThrow(/credential-shaped string data/);
    },
  );
});

describe("managed startup messaging build files", () => {
  it("accepts the stock WeChat account token placeholder (#9397)", () => {
    expectProfileTransportAccepted(profileWithBuildSteps([wechatAccountBuildStep()]));
  });

  it.each([
    ["a raw token", `wechat-${"a".repeat(32)}`],
    ["a placeholder for another key", "openshell:resolve:env:SLACK_BOT_TOKEN"],
    ["a malformed placeholder", "openshell:resolve:env:WECHAT BOT TOKEN"],
  ])("rejects %s in the WeChat account build file (#9397)", (_label, token) => {
    expect(() =>
      validateManagedStartupProfile(
        profileWithBuildSteps([withWechatAccountToken(wechatAccountBuildStep(), token)]),
      ),
    ).toThrow(/credential-shaped/);
  });

  it("rejects the WeChat token placeholder at another build-file path (#9397)", () => {
    const step = wechatAccountBuildStep();
    const value = step.value as ManagedStartupJsonObject;
    const content = value.content as ManagedStartupJsonObject;
    const token = content.token as string;
    const { token: _token, ...contentWithoutToken } = content;
    expect(() =>
      validateManagedStartupProfile(
        profileWithBuildSteps([
          {
            ...step,
            value: {
              ...value,
              content: contentWithoutToken,
              metadata: { token },
            },
          },
        ]),
      ),
    ).toThrow(/credential-shaped/);
  });

  it.each([
    ["another channel", { channelId: "slack" }],
    ["another build kind", { kind: "build-arg" }],
    ["another hook", { hookId: "another-hook" }],
    ["another handler", { handler: "wechat.anotherHandler" }],
    ["another output", { outputId: "openclawConfigPatch" }],
    ["an optional output", { required: false }],
  ])("rejects the WeChat token placeholder in %s (#9397)", (_label, change) => {
    expect(() =>
      validateManagedStartupProfile(
        profileWithBuildSteps([{ ...wechatAccountBuildStep(), ...change }]),
      ),
    ).toThrow(/credential-shaped/);
  });

  it.each([
    ["an unrelated build file", "unrelated/accounts/wechat-account.json"],
    ["a parent-traversal account file", "openclaw-weixin/accounts/../other.json"],
    ["a nested account file", "openclaw-weixin/accounts/a/b.json"],
    ["a whitespace-prefixed account file", "openclaw-weixin/accounts/ account.json"],
  ])("rejects the WeChat token placeholder in %s (#9397)", (_label, path) => {
    const step = wechatAccountBuildStep();
    const value = step.value as ManagedStartupJsonObject;
    expect(() =>
      validateManagedStartupProfile(
        profileWithBuildSteps([
          {
            ...step,
            value: { ...value, path },
          },
        ]),
      ),
    ).toThrow(/credential-shaped/);
  });

  it.each([
    ["without an explicit mode", undefined],
    ["with a group-readable mode", "0640"],
  ])("rejects the WeChat token placeholder in an account file %s (#9397)", (_label, mode) => {
    const step = wechatAccountBuildStep();
    const value = step.value as ManagedStartupJsonObject;
    const { mode: _mode, ...valueWithoutMode } = value;
    expect(() =>
      validateManagedStartupProfile(
        profileWithBuildSteps([
          {
            ...step,
            value: mode === undefined ? valueWithoutMode : { ...value, mode },
          },
        ]),
      ),
    ).toThrow(/credential-shaped/);
  });

  it.each([
    ["a non-string savedAt", { savedAt: 1 }],
    ["a non-string baseUrl", { baseUrl: 1 }],
    ["a non-string userId", { userId: 1 }],
    ["an extra content field", { note: "unexpected" }],
  ])("rejects the WeChat token placeholder with %s (#9397)", (_label, change) => {
    const step = wechatAccountBuildStep();
    const value = step.value as ManagedStartupJsonObject;
    const content = value.content as ManagedStartupJsonObject;
    expect(() =>
      validateManagedStartupProfile(
        profileWithBuildSteps([
          { ...step, value: { ...value, content: { ...content, ...change } } },
        ]),
      ),
    ).toThrow(/credential-shaped/);
  });
});

describe("managed startup messaging agent renders", () => {
  it("accepts the stock Microsoft Teams webhook object (#9610)", async () => {
    expectProfileTransportAccepted(profileWithAgentRender([await teamsOpenClawChannelRender()]));
  });

  it.each([
    ["a string webhook", "openshell:resolve:env:MSTEAMS_APP_PASSWORD"],
    ["a raw credential", `xoxb-${"a".repeat(32)}`],
    ["a string port", { port: "3978", path: "/api/messages" }],
    ["a zero port", { port: 0, path: "/api/messages" }],
    ["an out-of-range port", { port: 65_536, path: "/api/messages" }],
    ["a fractional port", { port: 3978.5, path: "/api/messages" }],
    ["another path", { port: 3978, path: "/other" }],
    [
      "an extra credential-shaped field",
      { port: 3978, path: "/api/messages", token: `teams-${"a".repeat(32)}` },
    ],
  ])("rejects %s in the Microsoft Teams render (#9610)", async (_label, webhook) => {
    const render = withTeamsWebhook(await teamsOpenClawChannelRender(), webhook);
    expect(() => validateManagedStartupProfile(profileWithAgentRender([render]))).toThrow(
      /credential-shaped/,
    );
  });

  it.each([
    ["another channel", { channelId: "slack" }],
    ["another render", { renderId: "teams-other-render" }],
    ["another hook", { hookId: "teams-other-hook" }],
    ["another handler", { handler: "teams.otherHandler" }],
    ["another kind", { kind: "env-lines" }],
    ["another agent", { agent: "hermes" }],
    ["another target", { target: "other.json" }],
    ["another config path", { path: "channels.other" }],
  ])("rejects the Microsoft Teams webhook in %s (#9610)", async (_label, change) => {
    const render = await teamsOpenClawChannelRender();
    expect(() =>
      validateManagedStartupProfile(profileWithAgentRender([{ ...render, ...change }])),
    ).toThrow(/credential-shaped field name/);
  });

  it("rejects the Microsoft Teams webhook at an unowned path (#9610)", async () => {
    const render = await teamsOpenClawChannelRender();
    const value = render.value as ManagedStartupJsonObject;
    const webhook = value.webhook as ManagedStartupJsonObject;
    const { webhook: _webhook, ...valueWithoutWebhook } = value;
    expect(() =>
      validateManagedStartupProfile(
        profileWithAgentRender([
          { ...render, value: { ...valueWithoutWebhook, metadata: { webhook } } },
        ]),
      ),
    ).toThrow(/credential-shaped field name/);
  });
});
