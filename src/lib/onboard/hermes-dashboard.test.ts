// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createHermesDashboardForwardEnsurer,
  getHermesDashboardRegistryFields,
  hasHermesDashboardDrift,
  resolveHermesDashboardOnboardState,
} from "./hermes-dashboard";

describe("onboard Hermes dashboard helpers", () => {
  it("rejects dashboard/API port overlap before sandbox create", () => {
    expect(() =>
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 9119,
        env: { NEMOCLAW_HERMES_DASHBOARD: "1" },
      }),
    ).toThrow(/must not equal the Hermes API port/);
  });

  it("rejects the internal dashboard port colliding with the OpenClaw dashboard port", () => {
    // The external port was already guarded against effectivePort; the internal
    // port must be too, or NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT set to the
    // chat-UI port silently collides at forward time.
    expect(() =>
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 19119,
        env: { NEMOCLAW_HERMES_DASHBOARD: "1" },
      }),
    ).toThrow(/NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT must not equal the Hermes API port/);
  });

  it("tracks registry drift for enabled dashboard settings", () => {
    const state = resolveHermesDashboardOnboardState({
      agentName: "hermes",
      effectivePort: 8642,
      env: {
        NEMOCLAW_HERMES_DASHBOARD: "1",
        NEMOCLAW_HERMES_DASHBOARD_PORT: "9120",
      },
    });

    expect(getHermesDashboardRegistryFields(state)).toMatchObject({
      hermesDashboardEnabled: true,
      hermesDashboardPort: 9120,
      hermesDashboardInternalPort: 19119,
    });
    expect(
      hasHermesDashboardDrift({
        agentName: "hermes",
        state,
        existing: { name: "h", agent: "hermes", hermesDashboardEnabled: false },
      }),
    ).toBe(true);
  });

  it("rolls back and fails when an opted-in dashboard forward cannot start", () => {
    const rollback = vi.fn();
    const fail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const ensure = createHermesDashboardForwardEnsurer({
      state: resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 8642,
        env: { NEMOCLAW_HERMES_DASHBOARD: "1" },
      }),
      ensureForward: vi.fn(() => false),
      note: vi.fn(),
      rollbackSandbox: rollback,
      fail,
    });

    expect(() => ensure("my-hermes", true)).toThrow(/Failed to start Hermes dashboard forward/);
    expect(rollback).toHaveBeenCalledWith("my-hermes");
    expect(fail).toHaveBeenCalled();
  });
});
