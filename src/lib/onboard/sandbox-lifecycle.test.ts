// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";

const registryState = vi.hoisted(() => ({
  removeSandbox: vi.fn(),
  removeSandboxRouteReservationIfCurrent: vi.fn(),
  sandbox: null as SandboxEntry | null,
}));
const onboardSessionState = vi.hoisted(() => ({
  lockHeld: true,
  sessionId: "session-owner" as string | null,
  recreate: null as { sandboxName: string; phase: string } | null,
}));

vi.mock("../state/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/registry")>();
  return {
    ...actual,
    getSandbox: () => registryState.sandbox,
    removeSandbox: registryState.removeSandbox,
    removeSandboxRouteReservationIfCurrent: registryState.removeSandboxRouteReservationIfCurrent,
  };
});
vi.mock("../state/onboard-session", () => ({
  isOnboardLockHeldByCurrentProcess: () => onboardSessionState.lockHeld,
  loadSession: () =>
    onboardSessionState.sessionId === null
      ? null
      : {
          sessionId: onboardSessionState.sessionId,
          checkpoint: onboardSessionState.recreate
            ? { sandboxRecreate: onboardSessionState.recreate }
            : null,
        },
}));
import {
  createSandboxLifecycleHelpers,
  removeSandboxUnlessSessionReservation,
} from "./sandbox-lifecycle";

describe("sandbox recreate reservation ownership", () => {
  beforeEach(() => {
    registryState.removeSandbox.mockReset();
    registryState.removeSandboxRouteReservationIfCurrent.mockReset();
    registryState.removeSandboxRouteReservationIfCurrent.mockReturnValue(true);
    onboardSessionState.lockHeld = true;
    onboardSessionState.sessionId = "session-owner";
    onboardSessionState.recreate = null;
  });

  it("preserves a pending reservation owned by the active session (#6562)", () => {
    removeSandboxUnlessSessionReservation(
      {
        name: "alpha",
        pendingRouteReservation: true,
        reservationSessionId: "session-owner",
      },
      "alpha",
    );

    expect(registryState.removeSandbox).not.toHaveBeenCalled();
    expect(registryState.removeSandboxRouteReservationIfCurrent).not.toHaveBeenCalled();
  });

  it("preserves the source registry row while a recreate journal is active (#6492)", () => {
    onboardSessionState.recreate = { sandboxName: "alpha", phase: "deleting" };
    removeSandboxUnlessSessionReservation({ name: "alpha", agent: "openclaw" }, "alpha");

    expect(registryState.removeSandbox).not.toHaveBeenCalled();
    expect(registryState.removeSandboxRouteReservationIfCurrent).not.toHaveBeenCalled();
  });

  it("removes an exact stale route reservation while the recreate journal is active (#9833)", () => {
    onboardSessionState.recreate = { sandboxName: "alpha", phase: "deleting" };
    const entry = {
      name: "alpha",
      pendingRouteReservation: true as const,
      reservationSessionId: "session-other",
    };

    removeSandboxUnlessSessionReservation(entry, "alpha");

    expect(registryState.removeSandbox).not.toHaveBeenCalled();
    expect(registryState.removeSandboxRouteReservationIfCurrent).toHaveBeenCalledExactlyOnceWith(
      entry,
    );
  });

  it.each([
    {
      label: "foreign-session",
      entry: {
        name: "alpha",
        pendingRouteReservation: true,
        reservationSessionId: "session-other",
      },
    },
    {
      label: "unstamped",
      entry: { name: "alpha", pendingRouteReservation: true },
    },
  ] as const)("removes a $label pending reservation before recreation (#6562)", ({ entry }) => {
    removeSandboxUnlessSessionReservation(entry, "alpha");

    expect(registryState.removeSandbox).not.toHaveBeenCalled();
    expect(registryState.removeSandboxRouteReservationIfCurrent).toHaveBeenCalledOnce();
    expect(registryState.removeSandboxRouteReservationIfCurrent).toHaveBeenCalledWith(entry);
  });

  it.each([
    ["foreign", "session-other"],
    ["unstamped", undefined],
  ] as const)(
    "preserves a %s verified-create checkpoint when stale-reservation cleanup is refused (#9833)",
    (_label, reservationSessionId) => {
      registryState.removeSandboxRouteReservationIfCurrent.mockReturnValue(false);
      const entry = {
        name: "alpha",
        pendingRouteReservation: true as const,
        ...(reservationSessionId ? { reservationSessionId } : {}),
        pendingPolicyVerification: {} as never,
      };

      expect(() => removeSandboxUnlessSessionReservation(entry, "alpha")).toThrow(
        /pending create recovery state.*--resume.*only when that session retains authority/u,
      );
      expect(registryState.removeSandbox).not.toHaveBeenCalled();
      expect(registryState.removeSandboxRouteReservationIfCurrent).toHaveBeenCalledExactlyOnceWith(
        entry,
      );
    },
  );

  it("preserves a foreign reservation without exclusive stale-session authority (#9833)", () => {
    onboardSessionState.lockHeld = false;
    removeSandboxUnlessSessionReservation(
      {
        name: "alpha",
        pendingRouteReservation: true,
        reservationSessionId: "session-other",
      },
      "alpha",
    );

    expect(registryState.removeSandbox).not.toHaveBeenCalled();
    expect(registryState.removeSandboxRouteReservationIfCurrent).not.toHaveBeenCalled();
  });
});

describe("sandbox lifecycle MCP destroy boundaries", () => {
  beforeEach(() => {
    registryState.removeSandbox.mockReset();
    registryState.removeSandboxRouteReservationIfCurrent.mockReset();
    registryState.removeSandboxRouteReservationIfCurrent.mockReturnValue(true);
    onboardSessionState.lockHeld = true;
    registryState.sandbox = null;
    onboardSessionState.sessionId = "session-owner";
    onboardSessionState.recreate = null;
  });

  it.each([
    ["destroyPreparedAt", "without bridges", false],
    ["destroyPreparedAt", "with bridges", true],
    ["destroyPendingAt", "without bridges", false],
    ["destroyPendingAt", "with bridges", true],
  ] as const)(
    "preserves %s and blocks absent-sandbox recreation %s",
    (marker, _bridgeState, withBridge) => {
      const runCaptureOpenshell = vi.fn(() => null);
      registryState.sandbox = {
        name: "alpha",
        agent: "openclaw",
        mcp: {
          bridges: withBridge
            ? {
                github: {
                  server: "github",
                  agent: "openclaw",
                  adapter: "mcporter",
                  url: "https://mcp.example.test/mcp",
                  env: ["GITHUB_TOKEN"],
                  providerName: "alpha-mcp-github",
                  providerId: "provider-123",
                  policyName: "mcp-github",
                  addedAt: "2026-07-02T22:49:42.000Z",
                },
              }
            : {},
          [marker]: "2026-07-02T22:49:42.000Z",
        },
      };
      const before = JSON.stringify(registryState.sandbox);
      const helpers = createSandboxLifecycleHelpers({
        runCaptureOpenshell,
        getGatewayName: () => "nemoclaw-18081",
        fetchGatewayAuthTokenFromSandbox: () => null,
        agentProductName: () => "OpenClaw",
        prompt: async () => "no",
        isAffirmativeAnswer: () => false,
      });

      expect(() => helpers.inspectSandboxForCreate("alpha")).toThrow(
        /incomplete MCP destroy transaction.*finish cleanup before recreating/i,
      );
      expect(runCaptureOpenshell).not.toHaveBeenCalled();
      expect(registryState.removeSandbox).not.toHaveBeenCalled();
      expect(JSON.stringify(registryState.sandbox)).toBe(before);
    },
  );

  it("keeps the source registry row when OpenShell reports no sandbox (#7736)", () => {
    const rows = new Map<string, SandboxEntry>([
      ["beta", { name: "beta", agent: "openclaw", toolDisclosure: "progressive" }],
    ]);
    registryState.removeSandbox.mockImplementation((name: string) => {
      rows.delete(name);
    });
    registryState.sandbox = rows.get("beta") ?? null;
    onboardSessionState.recreate = { sandboxName: "beta", phase: "deleting" };
    const helpers = createSandboxLifecycleHelpers({
      runCaptureOpenshell: () => null,
      getGatewayName: () => "nemoclaw-18081",
      fetchGatewayAuthTokenFromSandbox: () => null,
      agentProductName: () => "OpenClaw",
      prompt: async () => "no",
      isAffirmativeAnswer: () => false,
    });

    const inspected = helpers.inspectSandboxForCreate("beta");
    removeSandboxUnlessSessionReservation(inspected.existingEntry, "beta");

    expect(inspected.liveExists).toBe(false);
    expect(rows.get("beta")).toMatchObject({ name: "beta", toolDisclosure: "progressive" });
  });

  it("inspects a stale registry entry without pruning it", () => {
    const runCaptureOpenshell = vi.fn(() => null);
    registryState.sandbox = { name: "alpha", agent: "openclaw" };
    const helpers = createSandboxLifecycleHelpers({
      runCaptureOpenshell,
      getGatewayName: () => "nemoclaw-18081",
      fetchGatewayAuthTokenFromSandbox: () => null,
      agentProductName: () => "OpenClaw",
      prompt: async () => "no",
      isAffirmativeAnswer: () => false,
    });

    expect(helpers.inspectSandboxForCreate("alpha")).toMatchObject({
      existingEntry: registryState.sandbox,
      liveExists: false,
      preservedMcpState: undefined,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "--gateway", "nemoclaw-18081", "alpha"],
      { ignoreError: true },
    );
    expect(registryState.removeSandbox).not.toHaveBeenCalled();
  });
});
