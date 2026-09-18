// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import type { SandboxMessagingPlan } from "../../messaging/manifest";

const mocks = vi.hoisted(() => ({ runOpenshell: vi.fn() }));

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
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

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("pins every post-restore config operation to the rebuild target (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };

    finalizePendingMessagingRemovalsAfterRestore(removalPlan(), vi.fn(), runtimeSelection);

    expect(mocks.runOpenshell).toHaveBeenCalled();
    const selectedTargets = mocks.runOpenshell.mock.calls.map(([, options]) => ({
      endpoint: options.env.OPENSHELL_GATEWAY_ENDPOINT,
      gateway: options.env.OPENSHELL_GATEWAY,
      insecure: options.env.OPENSHELL_GATEWAY_INSECURE,
      replaceEnv: options.replaceEnv,
      tlsDir: options.env.OPENSHELL_LOCAL_TLS_DIR,
      token: options.env.OPENSHELL_TOKEN,
      workspace: options.env.OPENSHELL_WORKSPACE,
    }));
    expect(selectedTargets).toEqual(
      new Array(selectedTargets.length).fill({
        endpoint: undefined,
        gateway: "recorded-gateway",
        insecure: undefined,
        replaceEnv: true,
        tlsDir: "/authority/tls",
        token: undefined,
        workspace: "default",
      }),
    );
  });
});
