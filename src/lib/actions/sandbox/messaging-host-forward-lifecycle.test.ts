// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
  getOpenshellBinary: vi.fn(() => "openshell"),
  isCommandTimeout: vi.fn(() => false),
  runOpenshell: vi.fn(() => ({ status: 0 })),
}));

function makePlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "teams",
        displayName: "Microsoft Teams",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
        hostForward: {
          channelId: "teams",
          port: 3978,
          label: "Microsoft Teams webhook",
        },
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("ensureMessagingHostForwardAfterRebuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed without published ForwardTcp authority", () => {
    vi.mocked(captureOpenshell).mockReturnValue({ status: 1, output: "" });

    const ok = ensureMessagingHostForwardAfterRebuild("demo", makePlan());

    expect(ok).toBe(false);
    expect(captureOpenshell).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
