// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MANAGED_IMAGE_REPOSITORIES,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../src/lib/onboard/managed-image/contract.ts";

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
const SELECTED_REVISION = "c".repeat(40);
const SELECTED_COHORT = "ghrun-123-4";
const PLATFORM = "linux/amd64";
const selectedReferences = Object.fromEntries(
  SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, agentIndex) => [
    agent,
    Object.fromEntries(
      ["linux/amd64", "linux/arm64"].map((platform, platformIndex) => [
        platform,
        `${MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:${String(agentIndex + platformIndex + 1).repeat(64)}`,
      ]),
    ),
  ]),
) as Record<string, Record<string, string>>;

function selectedEnvironment(): NodeJS.ProcessEnv {
  return {
    E2E_MANAGED_IMAGE_REVISION: SELECTED_REVISION,
    E2E_MANAGED_IMAGE_COHORT_RECEIPT: JSON.stringify({
      kind: "nemoclaw-managed-image-cohort-receipt-v1",
      cohort: SELECTED_COHORT,
      revision: SELECTED_REVISION,
      runAttempt: 4,
      runId: 123,
      images: selectedReferences,
    }),
  };
}

function selectedWorkload(
  agent: keyof typeof MANAGED_IMAGE_REPOSITORIES,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "managed-image",
    platform: PLATFORM,
    reference: selectedReferences[agent][PLATFORM],
    sourceCohort: SELECTED_COHORT,
    sourceRevision: SELECTED_REVISION,
    ...overrides,
  };
}

function candidateCatalog(): Record<string, unknown> {
  return Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => {
      const reference = selectedReferences[agent][PLATFORM];
      return [
        agent,
        {
          contractVersion: 1,
          agent,
          platform: PLATFORM,
          image: MANAGED_IMAGE_REPOSITORIES[agent],
          digest: reference.slice(reference.indexOf("@") + 1),
          reference,
          source: {
            repository: "NVIDIA/NemoClaw",
            revision: SELECTED_REVISION,
            release: "v0.0.114",
            cohort: SELECTED_COHORT,
          },
          startupProfileContractVersion: 1,
          capabilityContractVersion: 1,
        },
      ];
    }),
  );
}

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

  it("retains inline candidate authority and validates its exact MCP workload", () => {
    const inlineCatalog = JSON.stringify(candidateCatalog());
    const environment = buildMcpBridgeExactMainEnv({
      baseEnv: {
        GITHUB_ACTIONS: "true",
        HOME: "/tmp/home",
        PATH: "/usr/bin",
        NEMOCLAW_E2E_EXPECTED_SHA: SELECTED_REVISION,
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON: inlineCatalog,
        NEMOCLAW_RUN_LIVE_E2E: "1",
      },
    });

    expect(environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON).toBe(inlineCatalog);
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment,
        expectedAgent: "langchain-deepagents-code",
        workload: {
          ...selectedWorkload("langchain-deepagents-code"),
          release: "v0.0.114",
        },
      }),
    ).not.toThrow();
  });

  it("rejects a Dockerfile workload in managed-image MCP qualification", () => {
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment: selectedEnvironment(),
        expectedAgent: "langchain-deepagents-code",
        workload: selectedWorkload("langchain-deepagents-code", { kind: "dockerfile" }),
      }),
    ).toThrow("must use the exact agent image from the selected cohort");
  });

  it("rejects a managed image from a different candidate revision", () => {
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment: selectedEnvironment(),
        expectedAgent: "langchain-deepagents-code",
        workload: selectedWorkload("langchain-deepagents-code", {
          sourceRevision: "b".repeat(40),
        }),
      }),
    ).toThrow("must use the exact agent image from the selected cohort");
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
    const revision = "a".repeat(40);
    const cohort = "ghrun-77-2";
    const reference = `${MANAGED_IMAGE_REPOSITORIES["langchain-deepagents-code"]}@sha256:${"d".repeat(64)}`;
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(
      catalogPath,
      JSON.stringify(
        Object.fromEntries(
          SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
            const digest =
              agent === "langchain-deepagents-code"
                ? `sha256:${"d".repeat(64)}`
                : `sha256:${String(index + 1).repeat(64)}`;
            return [
              agent,
              {
                contractVersion: 1,
                agent,
                platform: PLATFORM,
                image: MANAGED_IMAGE_REPOSITORIES[agent],
                digest,
                reference:
                  agent === "langchain-deepagents-code"
                    ? reference
                    : `${MANAGED_IMAGE_REPOSITORIES[agent]}@${digest}`,
                source: {
                  repository: "NVIDIA/NemoClaw",
                  revision,
                  release: "v0.0.114",
                  cohort,
                },
                startupProfileContractVersion: 1,
                capabilityContractVersion: 1,
              },
            ];
          }),
        ),
      ),
      { mode: 0o600 },
    );
    try {
      expect(() =>
        assertMcpBridgeManagedImageReceipt({
          environment: {
            E2E_MANAGED_IMAGE_REVISION: "",
            GITHUB_ACTIONS: "true",
            NEMOCLAW_E2E_EXPECTED_SHA: revision,
            NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
            NEMOCLAW_RUN_LIVE_E2E: "1",
          },
          expectedAgent: "langchain-deepagents-code",
          workload: {
            kind: "managed-image",
            platform: PLATFORM,
            reference,
            release: "v0.0.114",
            sourceCohort: cohort,
            sourceRevision: revision,
          },
        }),
      ).not.toThrow();
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic-link candidate catalog", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-catalog-link-"));
    const targetPath = path.join(fixtureRoot, "catalog.json");
    const linkPath = path.join(fixtureRoot, "selected.json");
    fs.writeFileSync(targetPath, "{}", { mode: 0o600 });
    fs.symlinkSync(targetPath, linkPath);
    try {
      expect(() =>
        assertMcpBridgeManagedImageReceipt({
          environment: {
            GITHUB_ACTIONS: "true",
            NEMOCLAW_E2E_EXPECTED_SHA: "a".repeat(40),
            NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: linkPath,
            NEMOCLAW_RUN_LIVE_E2E: "1",
          },
          expectedAgent: "langchain-deepagents-code",
          workload: selectedWorkload("langchain-deepagents-code"),
        }),
      ).toThrow("candidate managed-image catalog is invalid");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts the selected cross-release managed-image cohort revision", () => {
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment: selectedEnvironment(),
        expectedAgent: "langchain-deepagents-code",
        workload: selectedWorkload("langchain-deepagents-code"),
      }),
    ).not.toThrow();
  });

  it("rejects a different agent image from the selected cohort", () => {
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment: selectedEnvironment(),
        expectedAgent: "langchain-deepagents-code",
        workload: selectedWorkload("openclaw"),
      }),
    ).toThrow("must use the exact agent image from the selected cohort");
  });

  it("rejects a different publication cohort with the selected revision", () => {
    expect(() =>
      assertMcpBridgeManagedImageReceipt({
        environment: selectedEnvironment(),
        expectedAgent: "langchain-deepagents-code",
        workload: selectedWorkload("langchain-deepagents-code", {
          sourceCohort: "ghrun-999-1",
        }),
      }),
    ).toThrow("must use the exact agent image from the selected cohort");
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
