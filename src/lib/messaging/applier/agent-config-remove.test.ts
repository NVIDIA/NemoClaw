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
      {
        agent: "hermes",
        channelId: "wechat",
        kind: "env-lines",
        target: "~/.hermes/.env",
        lines: ["WEIXIN_ACCOUNT_ID=removed", "WEIXIN_BASE_URL=https://removed.example"],
        templateRefs: [],
      },
    ],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("disabled channel agent config removal", () => {
  it("removes only the retired Hermes channel's manifest-owned JSON and env entries", () => {
    const target = "/sandbox/.hermes/config.yaml";
    const envTarget = "/sandbox/.hermes/.env";
    const contents = new Map([
      [
        target,
        YAML.stringify({
          platforms: {
            weixin: { enabled: true },
            teams: { enabled: true },
          },
          preserved: true,
        }),
      ],
      [
        envTarget,
        "WEIXIN_ACCOUNT_ID=removed\nTEAMS_TOKEN=kept\nWEIXIN_BASE_URL=https://removed.example\n",
      ],
    ]);

    const result = MessagingSetupApplier.removeDisabledChannelAgentConfigAtOpenShell(
      disabledWechatPlan(),
      "wechat",
      {
        runOpenshell: (args, options) => {
          const reading = args.includes("cat") && options?.input === undefined;
          const selectedTarget = [target, envTarget].find((candidate) => args.includes(candidate));
          selectedTarget && options?.input !== undefined
            ? contents.set(selectedTarget, options.input)
            : undefined;
          return !selectedTarget
            ? { status: 1, stderr: "unexpected target" }
            : reading
              ? { status: 0, stdout: contents.get(selectedTarget) }
              : { status: 0 };
        },
      },
    );

    expect(result.appliedTargets).toEqual([target, envTarget]);
    expect(YAML.parse(contents.get(target) ?? "")).toEqual({
      platforms: { teams: { enabled: true } },
      preserved: true,
    });
    expect(contents.get(envTarget)).toBe("TEAMS_TOKEN=kept\n");
  });

  it("accepts verified absence but rejects an unreadable target", () => {
    const absent = MessagingSetupApplier.removeDisabledChannelAgentConfigAtOpenShell(
      { ...disabledWechatPlan(), agentRender: disabledWechatPlan().agentRender.slice(0, 1) },
      "wechat",
      {
        runOpenshell: (args) =>
          args.includes("cat") ? { status: 1, stderr: "missing" } : { status: 0 },
      },
    );
    expect(absent.appliedTargets).toEqual([]);

    expect(() =>
      MessagingSetupApplier.removeDisabledChannelAgentConfigAtOpenShell(
        { ...disabledWechatPlan(), agentRender: disabledWechatPlan().agentRender.slice(0, 1) },
        "wechat",
        { runOpenshell: () => ({ status: 1, stderr: "permission denied" }) },
      ),
    ).toThrow("Failed to read messaging agent config");
  });
});
