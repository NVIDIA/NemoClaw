// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  encodeManagedStartupProfile,
  type ManagedStartupJsonObject,
  type ManagedStartupJsonValue,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile.ts";

// Keep the retired Slack alias to cover the legacy same-key rewrite shape.
const slackBotAlias = {
  envKey: "SLACK_BOT_TOKEN",
  match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
  value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
  message: "[channels] Normalized SLACK_BOT_TOKEN runtime placeholder to the Bolt-compatible alias",
} as const;

const wechatTokenAlias = {
  channelId: "wechat",
  envKey: "WECHAT_BOT_TOKEN",
  targetEnvKey: "WEIXIN_TOKEN",
  match: "^openshell:resolve:env:v[0-9]+_WECHAT_BOT_TOKEN$",
  value: "openshell:resolve:env:WECHAT_BOT_TOKEN",
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
  return {
    channelId: "wechat",
    kind: "build-file",
    hookId: "wechat-seed-openclaw-account",
    handler: "wechat.seedOpenClawAccount",
    outputId: "openclawWeixinAccountFile",
    required: true,
    value: {
      path: "openclaw-weixin/accounts/wechat-account.json",
      mode: "0600",
      content: {
        token: "openshell:resolve:env:WECHAT_BOT_TOKEN",
        savedAt: "2026-08-18T00:00:00.000Z",
      },
    },
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

function teamsOpenClawChannelRender(): ManagedStartupJsonObject {
  return {
    channelId: "teams",
    renderId: "teams-openclaw-channel",
    hookId: "teams-openclaw-channel",
    handler: "common.staticOutputs",
    kind: "json-fragment",
    agent: "openclaw",
    target: "openclaw.json",
    path: "channels.msteams",
    value: {
      webhook: { port: 3978, path: "/api/messages" },
    },
  };
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

  it("accepts an owned cross-key credential alias (#10079)", () => {
    expect(() =>
      validateManagedStartupProfile(profileWithAliases([wechatTokenAlias])),
    ).not.toThrow();
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

  it.each([
    ["an unowned target", { ...wechatTokenAlias, targetEnvKey: "AWS_SECRET_KEY" }],
    ["an alias owned by another channel", { ...wechatTokenAlias, channelId: "slack" }],
  ])("rejects cross-key credential alias with %s (#10079)", (_label, alias) => {
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
  it("accepts the Microsoft Teams webhook contract (#9610)", () => {
    expectProfileTransportAccepted(profileWithAgentRender([teamsOpenClawChannelRender()]));
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
  ])("rejects %s in the Microsoft Teams render (#9610)", (_label, webhook) => {
    const render = withTeamsWebhook(teamsOpenClawChannelRender(), webhook);
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
  ])("rejects the Microsoft Teams webhook in %s (#9610)", (_label, change) => {
    const render = teamsOpenClawChannelRender();
    expect(() =>
      validateManagedStartupProfile(profileWithAgentRender([{ ...render, ...change }])),
    ).toThrow(/credential-shaped field name/);
  });

  it("rejects the Microsoft Teams webhook at an unowned path (#9610)", () => {
    const render = teamsOpenClawChannelRender();
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
