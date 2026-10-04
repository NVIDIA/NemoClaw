// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { resolveMessagingPlanAuthority } from "./plan-authority";

function plan(
  sandboxName: string,
  workflow: SandboxMessagingPlan["workflow"],
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow,
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("messaging plan authority", () => {
  it("uses the registry plan when the registry is authoritative", () => {
    const registryPlan = plan("alpha", "rebuild");

    expect(
      resolveMessagingPlanAuthority({
        sandboxName: "alpha",
        registry: { authoritative: true, plan: registryPlan },
        stagedPlan: plan("alpha", "onboard"),
        sessionPlan: plan("alpha", "onboard"),
      }),
    ).toEqual({ source: "registry", plan: registryPlan });
  });

  it("returns the registry source with no plan when the registry is authoritative", () => {
    expect(
      resolveMessagingPlanAuthority({
        sandboxName: "alpha",
        registry: { authoritative: true, plan: null },
        stagedPlan: plan("alpha", "onboard"),
        sessionPlan: plan("alpha", "onboard"),
      }),
    ).toEqual({ source: "registry", plan: null });
  });

  it("uses a staged plan before a matching session plan when the registry is not authoritative", () => {
    const staged = plan("alpha", "onboard");
    const session = plan("alpha", "onboard");
    const base = {
      sandboxName: "alpha",
      registry: { authoritative: false, plan: null },
      sessionPlan: session,
    } as const;

    expect(resolveMessagingPlanAuthority({ ...base, stagedPlan: staged })).toEqual({
      source: "staged",
      plan: staged,
    });
    expect(resolveMessagingPlanAuthority({ ...base, stagedPlan: null })).toEqual({
      source: "session",
      plan: session,
    });
  });

  it("rejects a registry plan that targets another sandbox", () => {
    expect(() =>
      resolveMessagingPlanAuthority({
        sandboxName: "alpha",
        registry: { authoritative: true, plan: plan("beta", "rebuild") },
        stagedPlan: null,
        sessionPlan: null,
      }),
    ).toThrow("Registry messaging plan targets 'beta', not 'alpha'.");
  });

  it("rejects a staged plan that targets another sandbox", () => {
    expect(() =>
      resolveMessagingPlanAuthority({
        sandboxName: "alpha",
        registry: { authoritative: false, plan: null },
        stagedPlan: plan("beta", "onboard"),
        sessionPlan: null,
      }),
    ).toThrow("Staged messaging plan targets 'beta', not 'alpha'.");
  });

  it("rejects a session plan that targets another sandbox", () => {
    expect(() =>
      resolveMessagingPlanAuthority({
        sandboxName: "alpha",
        registry: { authoritative: false, plan: null },
        stagedPlan: null,
        sessionPlan: plan("beta", "onboard"),
      }),
    ).toThrow("Session messaging plan targets 'beta', not 'alpha'.");
  });
});
