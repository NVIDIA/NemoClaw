// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createHermesDashboardForwardEnsurer,
  createHermesDashboardOnboardForwarding,
  getHermesDashboardRegistryFields,
  hasHermesDashboardDrift,
  resolveHermesDashboardOnboardState,
} from "./hermes-dashboard";

describe("onboard Hermes dashboard helpers", () => {
  it("uses a non-default NEMOCLAW_DASHBOARD_PORT as the Hermes WebUI public port (#6277)", () => {
    expect(
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 9120,
        env: {
          NEMOCLAW_DASHBOARD_PORT: "9120",
          NEMOCLAW_HERMES_DASHBOARD: "1",
        },
      }),
    ).toMatchObject({
      enabled: true,
      config: {
        port: 9120,
        internalPort: 19119,
      },
    });
  });

  it("uses a non-default --control-ui-port as the Hermes WebUI public port (#6277)", () => {
    expect(
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 9121,
        env: { NEMOCLAW_HERMES_DASHBOARD: "1" },
      }),
    ).toMatchObject({
      enabled: true,
      config: {
        port: 9121,
        internalPort: 19119,
      },
    });
  });

  it("accepts a matching legacy Hermes dashboard port alias (#6277)", () => {
    expect(
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 9119,
        env: {
          NEMOCLAW_HERMES_DASHBOARD: "1",
          NEMOCLAW_HERMES_DASHBOARD_PORT: "9119",
        },
      }),
    ).toMatchObject({
      enabled: true,
      config: {
        port: 9119,
      },
    });
  });

  it("rejects a separate Hermes dashboard public port that would not match the OpenShell forward (#6277)", () => {
    expect(() =>
      resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 18789,
        env: {
          NEMOCLAW_HERMES_DASHBOARD: "1",
          NEMOCLAW_HERMES_DASHBOARD_PORT: "9119",
        },
      }),
    ).toThrow(/must match the NemoClaw dashboard port \(18789\)/);
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
    ).toThrow(/NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT must not equal the Hermes WebUI port/);
  });

  it("tracks registry drift for enabled dashboard settings", () => {
    const state = resolveHermesDashboardOnboardState({
      // 9120 = user-selected Hermes WebUI port; 8642 is the reserved API port (#4984).
      agentName: "hermes",
      effectivePort: 9120,
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

  it("routes the reserved-port rejection through fail() so onboarding exits non-zero (#4984)", () => {
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
    expect(fail).toHaveBeenCalledWith(
      expect.stringMatching(/set NEMOCLAW_DASHBOARD_PORT, or pass --control-ui-port <N>/i),
    );
    expect(fail.mock.calls[0]?.[0]).not.toContain("NEMOCLAW_HERMES_DASHBOARD_PORT");
  });

  it("stops Hermes dashboard forwarding when authority changes between retries (#9833)", () => {
    const starts: string[] = [];
    const revalidateSandboxIdentity = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("sandbox identity changed");
      });
    const ensureForward = vi.fn(
      (
        _sandboxName: string,
        _port: number,
        _label: string,
        revalidate?: (operation: string) => void,
      ) => {
        revalidate?.("start Hermes dashboard forward attempt 1");
        starts.push("attempt 1");
        revalidate?.("start Hermes dashboard forward attempt 2");
        starts.push("attempt 2");
        return true;
      },
    );
    const ensure = createHermesDashboardForwardEnsurer({
      state: resolveHermesDashboardOnboardState({
        agentName: "hermes",
        effectivePort: 18789,
        env: { NEMOCLAW_HERMES_DASHBOARD: "1" },
      }),
      ensureForward,
      note: vi.fn(),
      rollbackSandbox: vi.fn(),
      fail: (message): never => {
        throw new Error(message);
      },
    });

    expect(() => ensure("my-hermes", false, revalidateSandboxIdentity)).toThrow(
      "sandbox identity changed",
    );

    expect(starts).toEqual(["attempt 1"]);
    expect(revalidateSandboxIdentity).toHaveBeenCalledTimes(2);
  });

  it("stops Hermes dashboard rollback when authority changes between commands (#9833)", () => {
    const runOpenshell = vi.fn();
    const revalidateSandboxIdentity = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("sandbox identity changed");
      });
    const forwarding = createHermesDashboardOnboardForwarding({
      agentName: "hermes",
      env: { NEMOCLAW_HERMES_DASHBOARD: "1" },
      ensureForward: vi.fn(() => false),
      note: vi.fn(),
      runOpenshell,
      getApiForwardPort: () => "8642",
      fail: (message): never => {
        throw new Error(message);
      },
    });
    const state = forwarding.resolveStateForPort(18789);

    expect(() =>
      forwarding.ensureForState(state, "my-hermes", true, revalidateSandboxIdentity),
    ).toThrow("sandbox identity changed");

    expect(runOpenshell).toHaveBeenCalledTimes(1);
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "8642", "my-hermes"], {
      ignoreError: true,
    });
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["forward", "stop", "18789", "my-hermes"],
      expect.anything(),
    );
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "my-hermes"],
      expect.anything(),
    );
  });

  it("leaves the sandbox running after Hermes dashboard rollback (#9833)", () => {
    const runOpenshell = vi.fn();
    const forwarding = createHermesDashboardOnboardForwarding({
      agentName: "hermes",
      env: { NEMOCLAW_HERMES_DASHBOARD: "1" },
      ensureForward: vi.fn(() => false),
      note: vi.fn(),
      runOpenshell,
      getApiForwardPort: () => "8642",
      fail: (message): never => {
        throw new Error(message);
      },
    });
    const state = forwarding.resolveStateForPort(18789);

    expect(() => forwarding.ensureForState(state, "my-hermes", true)).toThrow(
      /left the sandbox running/u,
    );
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "8642", "my-hermes"], {
      ignoreError: true,
    });
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789", "my-hermes"], {
      ignoreError: true,
    });
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "my-hermes"],
      expect.anything(),
    );
  });
});
