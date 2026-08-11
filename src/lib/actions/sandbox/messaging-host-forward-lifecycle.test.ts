// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { ensureMessagingHostForwardAfterRebuild } from "./messaging-host-forward-lifecycle";

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
  getOpenshellBinary: vi.fn(() => "openshell"),
  runOpenshell: vi.fn(() => ({ status: 0 })),
}));

vi.mock("../../onboard/forward-start", () => ({
  buildDetachedForwardStartSpawn: vi.fn(() => vi.fn()),
  buildForwardStartProgressLogger: vi.fn(() => vi.fn()),
  runDetachedForwardStartWithRetries: vi.fn(() => ({ ok: true, diagnostic: "" })),
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

  it("preserves a failed list probe and skips forward cleanup (#8522)", () => {
    vi.mocked(captureOpenshell).mockReturnValue({ status: 1, output: "" });

    const ok = ensureMessagingHostForwardAfterRebuild("demo", makePlan());

    expect(ok).toBe(true);
    expect(captureOpenshell).toHaveBeenCalledTimes(2);
    expect(captureOpenshell).toHaveBeenNthCalledWith(
      1,
      ["forward", "list"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(captureOpenshell).toHaveBeenNthCalledWith(
      2,
      ["forward", "list"],
      expect.objectContaining({ ignoreError: true, timeout: expect.any(Number) }),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
