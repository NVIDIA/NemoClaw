// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";

const registryState = vi.hoisted(() => ({
  removeSandbox: vi.fn(),
  sandbox: null as SandboxEntry | null,
}));

vi.mock("../state/registry", () => ({
  getSandbox: () => registryState.sandbox,
  removeSandbox: registryState.removeSandbox,
}));

import { createSandboxLifecycleHelpers } from "./sandbox-lifecycle";

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

        expect(() => helpers.reconcileSandboxForCreate("alpha")).toThrow(
          /incomplete MCP destroy transaction.*finish cleanup before recreating/i,
        );
        expect(runCaptureOpenshell).not.toHaveBeenCalled();
        expect(registryState.removeSandbox).not.toHaveBeenCalled();
        expect(JSON.stringify(registryState.sandbox)).toBe(before);
      });
    }
  }
});
