// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import type { SandboxMessagingPlan } from "../../messaging/manifest";

const mocks = vi.hoisted(() => ({ runOpenshell: vi.fn() }));

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell: mocks.runOpenshell,
}));

import { finalizePendingMessagingRemovalsAfterRestore } from "./rebuild-messaging-phase";

function removalPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "hermes",
    workflow: "rebuild",
    channels: [
      {
        channelId: "wechat",
        displayName: "WeChat",
        authMode: "token-paste",
        active: false,
        selected: false,
        configured: false,
        disabled: true,
        pendingRemoval: true,
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

describe("post-restore messaging removal", () => {
  let contents: string;

  beforeEach(() => {
    contents = YAML.stringify({ platforms: { weixin: { enabled: true } }, preserved: true });
    mocks.runOpenshell.mockReset().mockImplementation((args, options) => {
      const reading = args.includes("cat") && options?.input === undefined;
      contents = options?.input ?? contents;
      return reading ? { status: 0, stdout: contents } : { status: 0 };
    });
  });

  it("applies the config tombstone and retires it before Hermes restart", () => {
    const finalized = finalizePendingMessagingRemovalsAfterRestore(removalPlan(), vi.fn());

    expect(YAML.parse(contents)).toEqual({ platforms: {}, preserved: true });
    expect(finalized?.channels).toEqual([]);
    expect(finalized?.disabledChannels).toEqual([]);
    expect(finalized?.agentRender).toEqual([]);
  });

  it("keeps the exact tombstone retryable after a cleanup failure", () => {
    mocks.runOpenshell.mockImplementationOnce(() => ({ status: 1, stderr: "read failed" }));
    mocks.runOpenshell.mockImplementationOnce(() => ({ status: 1, stderr: "not absent" }));
    expect(() => finalizePendingMessagingRemovalsAfterRestore(removalPlan(), vi.fn())).toThrow(
      "Failed to read messaging agent config",
    );

    const finalized = finalizePendingMessagingRemovalsAfterRestore(removalPlan(), vi.fn());
    expect(finalized?.channels).toEqual([]);
  });
});
