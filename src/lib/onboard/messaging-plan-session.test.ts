// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { getActiveChannelsFromPlan, getChannelsFromPlan } from "./messaging-plan-session";

describe("messaging plan session helpers", () => {
  it("treats an empty plan as an explicit empty channel selection", () => {
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "rebuild",
      channels: [],
      disabledChannels: [],
      credentialBindings: [],
      networkPolicy: {
        presets: [],
        entries: [],
      },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };

    expect(getChannelsFromPlan(plan)).toEqual([]);
    expect(getActiveChannelsFromPlan(plan)).toEqual([]);
  });

  it("returns null only when no plan is available", () => {
    expect(getChannelsFromPlan(null)).toBeNull();
    expect(getActiveChannelsFromPlan(undefined)).toBeNull();
  });
});
