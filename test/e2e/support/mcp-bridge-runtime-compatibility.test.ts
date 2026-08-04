// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { McpBridgeError } from "../../../src/lib/actions/sandbox/mcp-bridge-contracts.ts";
import {
  assertMcpCredentialBoundaryRuntimeVersion,
  MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
} from "../../../src/lib/actions/sandbox/mcp-bridge-validation.ts";
import {
  classifyMcpBridgeRuntimeCompatibility,
  MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT,
  mcpBridgeCompatibilityRiskSignal,
  recordMcpBridgeRuntimeCompatibility,
} from "../../../tools/e2e/mcp-bridge-runtime-compatibility.mts";
import { classifyPrGateEvidence } from "../../../tools/e2e/pr-e2e-gate.mts";
import { RISK_SIGNAL_FILE } from "../../../tools/e2e/risk-signal.ts";

const EXPECTED_SHA = "a".repeat(40);
const PLAN_HASH = "b".repeat(64);
const CORRELATION_ID = "123e4567-e89b-42d3-a456-426614174000";

function riskSignalEnv(artifactDirectory: string): NodeJS.ProcessEnv {
  return {
    E2E_ARTIFACT_DIR: artifactDirectory,
    E2E_TARGET_ID: "mcp-bridge-dev",
    GITHUB_WORKSPACE: "/test/workspace",
    NEMOCLAW_E2E_CORRELATION_ID: CORRELATION_ID,
    NEMOCLAW_E2E_EXPECTED_SHA: EXPECTED_SHA,
    NEMOCLAW_E2E_PLAN_HASH: PLAN_HASH,
    NEMOCLAW_E2E_SHARD: "hermes",
  };
}

function assertRuntimeVersion(version: string): () => void {
  return () =>
    assertMcpCredentialBoundaryRuntimeVersion({
      resolveOpenshell: () => "/test/openshell",
      runVersionCommand: () => ({
        status: 0,
        stdout: `openshell ${version}\n`,
        stderr: "",
      }),
    });
}

describe("MCP bridge dev runtime compatibility", () => {
  it("selects the full lifecycle for the reviewed OpenShell runtime (#6426)", () => {
    expect(
      classifyMcpBridgeRuntimeCompatibility(
        assertRuntimeVersion(MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION),
      ),
    ).toEqual({
      actualVersion: MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
      expectedVersion: MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
      mode: "full-lifecycle",
    });
  });

  it("labels aligned evidence as preflight-only until the lifecycle runs (#6426)", () => {
    const result = classifyMcpBridgeRuntimeCompatibility(
      assertRuntimeVersion(MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION),
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-compatibility-"));
    const outputPath = path.join(directory, "github-output.txt");
    try {
      expect(
        mcpBridgeCompatibilityRiskSignal(result, riskSignalEnv(directory), () => EXPECTED_SHA),
      ).toBeNull();
      recordMcpBridgeRuntimeCompatibility(result, {
        artifactDirectory: directory,
        githubOutputPath: outputPath,
      });

      const artifact = JSON.parse(
        fs.readFileSync(path.join(directory, MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT), "utf8"),
      );
      expect(artifact).toMatchObject({
        artifactKind: "runtime-compatibility-preflight",
        classificationStatus: "passed",
        compatibility: "supported-version",
        mode: "full-lifecycle",
        credentialBoundaryGate: "accepted",
        fullLifecycle: "required",
      });
      expect(artifact).not.toHaveProperty("status");
      expect(fs.readFileSync(outputPath, "utf8")).toContain("mode=full-lifecycle\n");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("reports an exact unsupported-version rejection as passing compatibility evidence (#6426)", () => {
    const result = classifyMcpBridgeRuntimeCompatibility(
      assertRuntimeVersion("0.0.78-dev.6+ga7271169"),
    );

    expect(result).toEqual({
      actualVersion: "0.0.78-dev.6+ga7271169",
      expectedVersion: MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
      mode: "expected-version-mismatch",
    });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-compatibility-"));
    const outputPath = path.join(directory, "github-output.txt");
    const summaryPath = path.join(directory, "summary.md");
    try {
      const riskSignal = mcpBridgeCompatibilityRiskSignal(
        result,
        riskSignalEnv(directory),
        () => EXPECTED_SHA,
      );
      recordMcpBridgeRuntimeCompatibility(result, {
        artifactDirectory: directory,
        githubOutputPath: outputPath,
        githubStepSummaryPath: summaryPath,
        riskSignal,
      });

      const artifact = JSON.parse(
        fs.readFileSync(path.join(directory, MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT), "utf8"),
      );
      expect(artifact).toMatchObject({
        artifactKind: "runtime-compatibility-preflight",
        classificationStatus: "passed",
        compatibility: "unsupported-version",
        mode: "expected-version-mismatch",
        expectedOpenShellVersion: MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
        actualOpenShellVersion: "0.0.78-dev.6+ga7271169",
        credentialBoundaryGate: "rejected-as-required",
        fullLifecycle: "not-run",
      });
      expect(artifact).not.toHaveProperty("status");
      expect(artifact).not.toHaveProperty("guardMessage");
      expect(fs.readFileSync(outputPath, "utf8")).toContain("mode=expected-version-mismatch\n");
      expect(fs.readFileSync(summaryPath, "utf8")).toContain(
        "the exact-version gate rejected the unsupported runtime as required",
      );
      expect(JSON.parse(fs.readFileSync(path.join(directory, RISK_SIGNAL_FILE), "utf8"))).toEqual({
        version: 1,
        jobId: "mcp-bridge-dev",
        shardId: "hermes",
        expectedSha: EXPECTED_SHA,
        testedSha: EXPECTED_SHA,
        planHash: PLAN_HASH,
        correlationId: CORRELATION_ID,
        passed: 1,
        failed: 0,
        skipped: 0,
        pending: 0,
        unhandledErrors: 0,
        runReason: "passed",
      });
      expect(fs.statSync(path.join(directory, RISK_SIGNAL_FILE)).mode & 0o777).toBe(0o600);
      expect(
        classifyPrGateEvidence({
          workflowConclusion: "success",
          expectedJobs: ["mcp-bridge-dev"],
          expectedShards: { "mcp-bridge-dev": ["hermes"] },
          signals: [riskSignal!],
        }),
      ).toEqual({
        conclusion: "success",
        title: "All selected E2E checks passed",
        summary: "Every expected E2E check shard passed with no skips or pending tests.",
      });
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps gated mismatch evidence bound to the canonical dev lane (#6426)", () => {
    const result = classifyMcpBridgeRuntimeCompatibility(
      assertRuntimeVersion("0.0.78-dev.6+ga7271169"),
    );
    const env = riskSignalEnv("/test/artifacts");

    expect(() =>
      mcpBridgeCompatibilityRiskSignal(
        result,
        { ...env, E2E_TARGET_ID: "mcp-bridge" },
        () => EXPECTED_SHA,
      ),
    ).toThrow(/requires mcp-bridge-dev/u);
    expect(() =>
      mcpBridgeCompatibilityRiskSignal(
        result,
        { ...env, NEMOCLAW_E2E_SHARD: "default" },
        () => EXPECTED_SHA,
      ),
    ).toThrow(/requires a reviewed agent shard/u);
    expect(() => mcpBridgeCompatibilityRiskSignal(result, env, () => "c".repeat(40))).toThrow(
      /checked-out HEAD/u,
    );
  });

  it("keeps every result except an exact version mismatch fatal (#6426)", () => {
    const fatalAssertions = [
      () => assertMcpCredentialBoundaryRuntimeVersion({ resolveOpenshell: () => null }),
      () =>
        assertMcpCredentialBoundaryRuntimeVersion({
          resolveOpenshell: () => "/test/openshell",
          runVersionCommand: () => ({
            error: Object.assign(new Error("probe failed"), { code: "EACCES" }),
            status: null,
            stdout: "",
            stderr: "",
          }),
        }),
      () =>
        assertMcpCredentialBoundaryRuntimeVersion({
          resolveOpenshell: () => "/test/openshell",
          runVersionCommand: () => ({ status: 23, stdout: "", stderr: "" }),
        }),
      () =>
        assertMcpCredentialBoundaryRuntimeVersion({
          resolveOpenshell: () => "/test/openshell",
          runVersionCommand: () => ({ status: 0, stdout: "not-a-version", stderr: "" }),
        }),
      () => {
        throw new McpBridgeError("unrelated MCP bridge failure");
      },
      () => {
        throw new Error("generic failure");
      },
    ];
    for (const assertRuntimeVersion of fatalAssertions) {
      expect(() => classifyMcpBridgeRuntimeCompatibility(assertRuntimeVersion)).toThrow();
    }
  });
});
