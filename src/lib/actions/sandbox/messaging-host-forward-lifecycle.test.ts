// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn(() => ({ status: 0 })),
  runDetachedForwardStartWithRetries: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  getOpenshellBinary: vi.fn(() => "/usr/bin/openshell"),
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("../../core/wait", () => ({ sleepSeconds: vi.fn() }));

vi.mock("../../onboard/forward-start", () => ({
  buildDetachedForwardStartSpawn: vi.fn(() => vi.fn()),
  buildForwardStartProgressLogger: vi.fn(() => vi.fn()),
  runDetachedForwardStartWithRetries: mocks.runDetachedForwardStartWithRetries,
}));

import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";

function makePlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "rebuild",
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
    mocks.runDetachedForwardStartWithRetries.mockReturnValue({ ok: true, diagnostic: "" });
  });

  it("skips the sandbox-scoped stop when OpenShell cannot list forwards (#8522)", () => {
    mocks.captureOpenshell.mockReturnValue({ status: 1, output: "" });

    const result = ensureMessagingHostForwardAfterRebuild("alpha", makePlan());

    expect(result).toBe(true);
    expect(mocks.captureOpenshell).toHaveBeenNthCalledWith(1, ["forward", "list"], {
      ignoreError: true,
    });
    expect(mocks.captureOpenshell).toHaveBeenNthCalledWith(2, ["forward", "list"], {
      ignoreError: true,
      timeout: 15_000,
    });
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
  });

  it("runs the sandbox-scoped stop when OpenShell returns an empty forward list (#8522)", () => {
    mocks.captureOpenshell.mockReturnValue({ status: 0, output: "" });

    const result = ensureMessagingHostForwardAfterRebuild("alpha", makePlan());

    expect(result).toBe(true);
    expect(mocks.runOpenshell).toHaveBeenCalledWith(["forward", "stop", "3978", "alpha"], {
      ignoreError: true,
      suppressOutput: true,
    });
  });
});
