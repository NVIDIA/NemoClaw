// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertMcpBridgeManagedImageReceipt,
  buildMcpBridgeExactMainEnv,
  buildMcpBridgeOnboardArgs,
  buildMcpBridgeOnboardEnv,
  requireMcpBridgeTlsCaCert,
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

  it("passes managed-image qualification inputs to MCP child commands", () => {
    const env = buildMcpBridgeExactMainEnv({
      baseEnv: {
        GITHUB_ACTIONS: "true",
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/tmp/managed-pr-catalog.json",
        NEMOCLAW_RUN_LIVE_E2E: "1",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor@sha256:test",
        UNRELATED_PARENT_VALUE: "must-not-leak",
      },
    });

    expect(env).toMatchObject({
      GITHUB_ACTIONS: "true",
      NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
      NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/tmp/managed-pr-catalog.json",
      NEMOCLAW_RUN_LIVE_E2E: "1",
      OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor@sha256:test",
    });
    expect(env.UNRELATED_PARENT_VALUE).toBeUndefined();
  });

  it("rejects a Dockerfile workload in managed-image MCP qualification", () => {
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment: {
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
          NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/tmp/managed-pr-catalog.json",
        },
        workload: { kind: "dockerfile" },
      }),
    ).toThrow("must use the exact managed image instead of a Dockerfile build");
  });

  it("rejects a managed image from a different candidate revision", () => {
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment: {
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
          NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/tmp/managed-pr-catalog.json",
        },
        workload: { kind: "managed-image", sourceRevision: "b".repeat(40) },
      }),
    ).toThrow("must use the exact managed image instead of a Dockerfile build");
  });

  it("activates the exact managed runtime when the qualification catalog is present", () => {
    expect(
      buildMcpBridgeOnboardArgs({
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/tmp/managed-pr-catalog.json",
      }),
    ).toEqual([
      "onboard",
      "--temp-managed-runtime",
      "--temp-managed-runtime-catalog",
      "/tmp/managed-pr-catalog.json",
      "--non-interactive",
      "--yes",
      "--yes-i-accept-third-party-software",
    ]);
  });

  it("accepts the exact managed image candidate revision", () => {
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment: {
          NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
          NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/tmp/managed-pr-catalog.json",
        },
        workload: { kind: "managed-image", sourceRevision: "a".repeat(40) },
      }),
    ).not.toThrow();
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

  it("passes the routed-private MCP test CA through the normal corporate CA input", () => {
    const env = buildMcpBridgeOnboardEnv({
      ...ONBOARD_OPTIONS,
      corporateCaBundle: "/tmp/nemoclaw-mcp-tls/ca.crt",
    });

    expect(env.NEMOCLAW_CORPORATE_CA_BUNDLE).toBe("/tmp/nemoclaw-mcp-tls/ca.crt");
  });

  it("passes exact PR managed-image catalog authority to onboarding commands (#8746)", () => {
    const revision = "a".repeat(40);
    const env = buildMcpBridgeOnboardEnv({
      ...ONBOARD_OPTIONS,
      baseEnv: {
        GITHUB_ACTIONS: "true",
        GITHUB_WORKSPACE: "/test/workspace",
        NEMOCLAW_E2E_EXPECTED_SHA: revision,
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/test/workspace/managed-pr-catalog.json",
        NEMOCLAW_RUN_LIVE_E2E: "1",
        NEMOCLAW_UNREVIEWED_WORKFLOW_INPUT: "must-not-pass",
      },
    });

    expect(env).toMatchObject({
      GITHUB_ACTIONS: "true",
      GITHUB_WORKSPACE: "/test/workspace",
      NEMOCLAW_E2E_EXPECTED_SHA: revision,
      NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/test/workspace/managed-pr-catalog.json",
      NEMOCLAW_RUN_LIVE_E2E: "1",
    });
    expect(env.NEMOCLAW_UNREVIEWED_WORKFLOW_INPUT).toBeUndefined();
  });

  it("requires the routed-private MCP test CA before onboarding", () => {
    expect(requireMcpBridgeTlsCaCert({ NEMOCLAW_MCP_TLS_CA_CERT: "/tmp/ca.crt" })).toBe(
      "/tmp/ca.crt",
    );
    expect(() => requireMcpBridgeTlsCaCert({})).toThrow("NEMOCLAW_MCP_TLS_CA_CERT is required");
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
