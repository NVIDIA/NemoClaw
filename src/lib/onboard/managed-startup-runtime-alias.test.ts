// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { slackManifest } from "../messaging/channels/slack/manifest.ts";
import { wechatManifest } from "../messaging/channels/wechat/manifest.ts";
import { buildWechatSeedOpenClawAccountOutputs } from "../messaging/channels/wechat/hooks/seed-openclaw-account.ts";
import {
  type ManagedStartupJsonObject,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile.ts";

const [slackBotAlias] = slackManifest.runtime.hermes.envAliases;

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

function withWechatAccountToken(
  step: ManagedStartupJsonObject,
  token: string,
): ManagedStartupJsonObject {
  const value = step.value as ManagedStartupJsonObject;
  const content = value.content as ManagedStartupJsonObject;
  return { ...step, value: { ...value, content: { ...content, token } } };
}

describe("managed startup runtime aliases", () => {
  it("accepts the stock Slack runtime aliases (#9397)", () => {
    expect(() =>
      validateManagedStartupProfile(profileWithAliases(slackManifest.runtime.hermes.envAliases)),
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
    expect(() =>
      validateManagedStartupProfile(profileWithBuildSteps([wechatAccountBuildStep()])),
    ).not.toThrow();
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
});
