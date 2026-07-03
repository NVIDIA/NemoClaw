// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxMessagingPlan } from "../messaging/manifest/types";
import { createAuthoritativeRebuildMessagingHelpers } from "./authoritative-rebuild-messaging";

const mocks = vi.hoisted(() => ({
  checkMessagingPlanConflicts: vi.fn(),
  getSandbox: vi.fn(),
  listExtraProviders: vi.fn(),
  plan: null as SandboxMessagingPlan | null,
  resolveDisabledChannels: vi.fn(),
}));

vi.mock("./messaging-channel-setup", () => ({
  readMessagingPlanFromEnv: () => mocks.plan,
}));
vi.mock("./channel-state", () => ({
  resolveDisabledChannels: mocks.resolveDisabledChannels,
}));
vi.mock("../state/registry", () => ({
  getSandbox: mocks.getSandbox,
  listExtraProviders: mocks.listExtraProviders,
}));
vi.mock("./sandbox-messaging-preflight", () => ({
  checkMessagingPlanConflicts: mocks.checkMessagingPlanConflicts,
}));

function plan(sandboxName: string, disabledChannels: string[] = []): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "rebuild",
    channels: [],
    disabledChannels,
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function helpers() {
  return createAuthoritativeRebuildMessagingHelpers({
    gatewayName: () => "nemoclaw",
    providerExistsInGateway: () => true,
    isNonInteractive: () => true,
    promptYesNoOrDefault: async () => true,
    cliName: () => "nemoclaw",
    getHermesToolGatewayBroker: () => ({
      ensureHermesToolGatewayBroker: () => true,
      getHermesToolGatewayProviderName: () => "alpha-hermes-tool-gateway",
    }),
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, value === undefined ? {} : { [name]: value });
}

describe("authoritative rebuild messaging", () => {
  const previousGateway = process.env.OPENSHELL_GATEWAY;

  beforeEach(() => {
    mocks.plan = plan("alpha");
    mocks.resolveDisabledChannels.mockReturnValue([]);
    mocks.getSandbox.mockReturnValue({ extraPlaceholderKeys: [] });
    mocks.listExtraProviders.mockReturnValue([]);
    mocks.checkMessagingPlanConflicts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnv("OPENSHELL_GATEWAY", previousGateway);
  });

  it("keeps the target gateway scoped across awaited conflict hooks (#6195)", async () => {
    process.env.OPENSHELL_GATEWAY = "original";
    let observedGateway: string | undefined;
    mocks.checkMessagingPlanConflicts.mockImplementation(async () => {
      await Promise.resolve();
      observedGateway = process.env.OPENSHELL_GATEWAY;
    });

    await helpers().preflightAuthoritativeRebuildMessagingConflicts({
      sandboxName: "alpha",
      targetGatewayName: "nemoclaw-31818",
      webSearchEnabled: false,
    });

    expect(observedGateway).toBe("nemoclaw-31818");
    expect(process.env.OPENSHELL_GATEWAY).toBe("original");
  });

  it("fails closed when the staged plan belongs to another sandbox (#6195)", () => {
    mocks.plan = plan("beta", ["telegram"]);

    expect(() =>
      helpers().snapshotAuthoritativeRebuildMessagingState({
        sandboxName: "alpha",
        targetGatewayName: "nemoclaw",
        webSearchEnabled: false,
      }),
    ).toThrow("Recorded messaging plan belongs to 'beta', not 'alpha'.");
  });

  it("rejects malformed recorded extra placeholder keys before delete (#6195)", () => {
    mocks.getSandbox.mockReturnValue({ extraPlaceholderKeys: ["not a valid env key"] });

    expect(() =>
      helpers().snapshotAuthoritativeRebuildMessagingState({
        sandboxName: "alpha",
        targetGatewayName: "nemoclaw",
        webSearchEnabled: false,
      }),
    ).toThrow("Recorded extra placeholder keys are invalid.");
  });
});
