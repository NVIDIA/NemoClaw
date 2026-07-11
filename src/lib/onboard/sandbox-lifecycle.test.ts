// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";

const registryState = vi.hoisted(() => ({
  removeSandbox: vi.fn(),
  sandbox: null as SandboxEntry | null,
}));
const onboardSessionState = vi.hoisted(() => ({ sessionId: "session-owner" as string | null }));

vi.mock("../state/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/registry")>();
  return {
    ...actual,
    getSandbox: () => registryState.sandbox,
    removeSandbox: registryState.removeSandbox,
  };
});
vi.mock("../state/onboard-session", () => ({
  loadSession: () =>
    onboardSessionState.sessionId === null ? null : { sessionId: onboardSessionState.sessionId },
}));

import {
  createSandboxLifecycleHelpers,
  removeSandboxUnlessSessionReservation,
} from "./sandbox-lifecycle";

describe("sandbox recreate reservation ownership", () => {
  beforeEach(() => {
    registryState.removeSandbox.mockReset();
    onboardSessionState.sessionId = "session-owner";
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

    expect(registryState.removeSandbox).toHaveBeenCalledOnce();
    expect(registryState.removeSandbox).toHaveBeenCalledWith("alpha");
  });
});

describe("sandbox lifecycle MCP destroy boundaries", () => {
  beforeEach(() => {
    registryState.removeSandbox.mockReset();
    registryState.sandbox = null;
  });

  for (const marker of ["destroyPreparedAt", "destroyPendingAt"] as const) {
    for (const withBridge of [false, true]) {
      it(`preserves ${marker} and blocks absent-sandbox recreation${withBridge ? " with bridges" : " without bridges"}`, () => {
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
      });
    }
  }

  it("inspects a stale registry entry without pruning it", () => {
    const runCaptureOpenshell = vi.fn(() => null);
    registryState.sandbox = { name: "alpha", agent: "openclaw" };
    const helpers = createSandboxLifecycleHelpers({
      runCaptureOpenshell,
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
    expect(registryState.removeSandbox).not.toHaveBeenCalled();
  });
});
