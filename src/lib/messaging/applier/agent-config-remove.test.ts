// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import type { SandboxMessagingPlan } from "../manifest";
import { MessagingSetupApplier } from "./setup-applier";

function disabledWechatPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "hermes",
    workflow: "remove-channel",
    channels: [
      {
        channelId: "wechat",
        displayName: "WeChat",
        authMode: "token-paste",
        active: false,
        selected: false,
        configured: true,
        disabled: true,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: ["wechat"],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [
      {
        agent: "hermes",
        channelId: "wechat",
        kind: "json-fragment",
        target: "~/.hermes/config.yaml",
        path: "platforms.weixin",
        value: { enabled: true },
        templateRefs: [],
      },
    ],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("disabled channel agent config removal", () => {
  it("removes only the retired Hermes channel's manifest-owned JSON path", () => {
    const target = "/sandbox/.hermes/config.yaml";
    let contents = YAML.stringify({
      platforms: {
        weixin: { enabled: true },
        teams: { enabled: true },
      },
      preserved: true,
    });

    const result = MessagingSetupApplier.removeDisabledChannelAgentConfigAtOpenShell(
      disabledWechatPlan(),
      "wechat",
      {
        runOpenshell: (args, options) => {
          const reading = args.includes("cat") && options?.input === undefined;
          const nextContents = options?.input;
          contents = nextContents ?? contents;
          return reading ? { status: 0, stdout: contents } : { status: 0 };
        },
      },
    );

    expect(result.appliedTargets).toEqual([target]);
    expect(YAML.parse(contents)).toEqual({
      platforms: { teams: { enabled: true } },
      preserved: true,
    });
  });
});
