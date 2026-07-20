// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildMcpBridgeExactMainEnv,
  buildMcpBridgeOnboardEnv,
} from "../live/mcp-bridge-onboard-env.ts";

const ONBOARD_OPTIONS = {
  agent: "langchain-deepagents-code" as const,
  baseEnv: { HOME: "/tmp/home", PATH: "/usr/bin" },
  compatibleKey: "compatible-test-key",
  compatibleModel: "mock/mcp-bridge",
  endpointUrl: "https://inference.example.test/v1",
  sandboxName: "e2e-mcp-dcode",
};

describe("MCP bridge onboarding environment", () => {
  it("restores exact-main OpenShell overrides after child environment sanitization", () => {
    const env = buildMcpBridgeExactMainEnv({
      baseEnv: {
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        NEMOCLAW_OPENSHELL_BIN: "/dropped/openshell",
      },
      envOverlay: {
        PATH: "/tmp/exact-main:/usr/bin",
        NEMOCLAW_OPENSHELL_BIN: "/tmp/exact-main/openshell",
        NEMOCLAW_OPENSHELL_GATEWAY_BIN: "/usr/local/bin/openshell-gateway",
        NEMOCLAW_OPENSHELL_SANDBOX_BIN: "/usr/local/bin/openshell-sandbox",
      },
    });

    expect(env).toMatchObject({
      PATH: "/tmp/exact-main:/usr/bin",
      NEMOCLAW_OPENSHELL_BIN: "/tmp/exact-main/openshell",
      NEMOCLAW_OPENSHELL_GATEWAY_BIN: "/usr/local/bin/openshell-gateway",
      NEMOCLAW_OPENSHELL_SANDBOX_BIN: "/usr/local/bin/openshell-sandbox",
    });
  });

  it("passes only exact-main OpenShell overrides after fixed onboarding values", () => {
    const env = buildMcpBridgeOnboardEnv({
      ...ONBOARD_OPTIONS,
      envOverlay: {
        PATH: "/tmp/exact-main:/usr/bin",
        NEMOCLAW_OPENSHELL_BIN: "/tmp/exact-main/openshell",
        NEMOCLAW_OPENSHELL_GATEWAY_BIN: "/usr/local/bin/openshell-gateway",
        NEMOCLAW_OPENSHELL_SANDBOX_BIN: "/usr/local/bin/openshell-sandbox",
      },
    });

    expect(env).toMatchObject({
      PATH: "/tmp/exact-main:/usr/bin",
      NEMOCLAW_AGENT: "langchain-deepagents-code",
      NEMOCLAW_ENDPOINT_URL: "https://inference.example.test/v1",
      NEMOCLAW_OPENSHELL_BIN: "/tmp/exact-main/openshell",
      NEMOCLAW_OPENSHELL_GATEWAY_BIN: "/usr/local/bin/openshell-gateway",
      NEMOCLAW_OPENSHELL_SANDBOX_BIN: "/usr/local/bin/openshell-sandbox",
    });
  });

  it("rejects protected onboarding key collisions", () => {
    expect(() =>
      buildMcpBridgeOnboardEnv({
        ...ONBOARD_OPTIONS,
        envOverlay: { NEMOCLAW_AGENT: "openclaw" },
      }),
    ).toThrow("does not allow env overlay key 'NEMOCLAW_AGENT'");
  });
});
