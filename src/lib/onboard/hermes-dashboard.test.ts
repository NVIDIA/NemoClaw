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
      // 18789 = realistic resolved dashboard port; 8642 is the reserved API port (#4984).
      agentName: "hermes",
      effectivePort: 18789,
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

  it("rejects NEMOCLAW_DASHBOARD_PORT set to the reserved Hermes API port 8642 (#4984)", () => {
    expect(() =>
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 18789,
        env: { NEMOCLAW_DASHBOARD_PORT: "8642" },
      }),
    ).toThrow(
      "[SECURITY] Invalid dashboard port 8642 - reserved for the Hermes OpenAI-compatible API",
    );
  });

  it("routes the #4984 rejection through fail() so onboarding exits non-zero", () => {
    const fail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    expect(() =>
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 18789,
        env: { NEMOCLAW_DASHBOARD_PORT: " 8642 " },
        fail,
      }),
    ).toThrow(/reserved for the Hermes OpenAI-compatible API/);
    expect(fail).toHaveBeenCalledOnce();
  });

  it("rejects a resolved dashboard port of 8642 from --control-ui-port / CHAT_UI_URL even when raw env is empty (#4984)", () => {
    // --control-ui-port / CHAT_UI_URL / persisted port can resolve effectivePort to
    // 8642 with the raw env unset; the host guard must still reject before build.
    expect(() =>
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 8642,
        env: {},
      }),
    ).toThrow(
      "[SECURITY] Invalid dashboard port 8642 - reserved for the Hermes OpenAI-compatible API",
    );
  });

  it("accepts a non-reserved NEMOCLAW_DASHBOARD_PORT for Hermes (#4984)", () => {
    expect(() =>
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 18789,
        env: { NEMOCLAW_DASHBOARD_PORT: "18790" },
      }),
    ).not.toThrow();
  });

  it("rejects the reserved Hermes API port 8642 even for non-Hermes agents (#4984)", () => {
    // A non-hermes onboard that binds 8642 squats the host port and silently
    // breaks a later `nemoclaw onboard` of hermes (whose API forwards 8642),
    // so the reserved-port guard is host-side and agent-agnostic.
    expect(() =>
      resolveHermesDashboardOnboardState({
        agentName: "openclaw",
        effectivePort: 18789,
        env: { NEMOCLAW_DASHBOARD_PORT: "8642" },
      }),
    ).toThrow(
      "[SECURITY] Invalid dashboard port 8642 - reserved for the Hermes OpenAI-compatible API",
    );
  });

  it("rolls back and fails when an opted-in dashboard forward cannot start", () => {
    const rollback = vi.fn();
    const fail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const ensure = createHermesDashboardForwardEnsurer({
      state: resolveHermesDashboardOnboardState({
        // 18789 = realistic resolved dashboard port; 8642 is now reserved (#4984).
        agentName: "hermes",
        effectivePort: 18789,
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
