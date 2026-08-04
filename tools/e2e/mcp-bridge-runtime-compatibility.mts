// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as importedMcpBridgeValidation from "../../src/lib/actions/sandbox/mcp-bridge-validation.ts";
import { createPrivateRegularFile } from "./private-file.mts";
import type { E2eRiskSignal } from "./risk-signal.ts";
import * as importedRiskSignal from "./risk-signal.ts";

// The root TypeScript package is exposed as CJS under the exact `node --import
// tsx` / `npx tsx` workflow execution mode, but as an ESM namespace under
// Vitest. Normalize both representations so the executable and tests load the
// same production assertion instead of maintaining a second version parser.
const mcpBridgeValidation = (
  "default" in importedMcpBridgeValidation && importedMcpBridgeValidation.default
    ? importedMcpBridgeValidation.default
    : importedMcpBridgeValidation
) as typeof import("../../src/lib/actions/sandbox/mcp-bridge-validation.ts");

const {
  assertMcpCredentialBoundaryRuntimeVersion,
  MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
  McpCredentialBoundaryRuntimeVersionError,
} = mcpBridgeValidation;
const riskSignal = (
  "default" in importedRiskSignal && importedRiskSignal.default
    ? importedRiskSignal.default
    : importedRiskSignal
) as typeof import("./risk-signal.ts");
const { buildRiskSignal, configuredRiskSignalEnvironment, RISK_SIGNAL_FILE } = riskSignal;

export const MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT = "openshell-runtime-compatibility.json";

export type McpBridgeRuntimeCompatibilityMode = "expected-version-mismatch" | "full-lifecycle";

export interface McpBridgeRuntimeCompatibilityResult {
  actualVersion: string;
  expectedVersion: string;
  mode: McpBridgeRuntimeCompatibilityMode;
}

type AssertRuntimeVersion = () => void;
const MCP_BRIDGE_DEV_JOB = "mcp-bridge-dev";
const MCP_BRIDGE_DEV_SHARDS = new Set(["openclaw", "hermes", "deepagents"]);

// invalidState: A moving OpenShell dev artifact enters credential-bearing MCP
// lifecycle assertions even though it is outside the reviewed manifest version.
// sourceBoundary: The versioned child-visible credential manifest and the
// production assertion own exact support; this workflow helper only classifies
// that assertion's typed version-mismatch result.
// whyNotSourceFix: NemoClaw cannot hold the upstream dev tag at one reviewed
// version, and weakening the production assertion would expose credentials to
// an unreviewed runtime.
// regressionTest: mcp-bridge-runtime-compatibility tests cover aligned,
// mismatch, and fatal probes; mcp-workflow-compatibility tests lock the branch.
// removalCondition: Remove this branch when an attested machine-readable
// credential-boundary capability replaces exact-version matching, or when this
// lane stops consuming a moving tag.
// relatedIssue: #6256 tracks exact runtime-versus-manifest attestation, not a
// removal milestone. Removal remains capability-based because no upstream date
// exists for an attested replacement.
export function classifyMcpBridgeRuntimeCompatibility(
  assertRuntimeVersion: AssertRuntimeVersion = assertMcpCredentialBoundaryRuntimeVersion,
): McpBridgeRuntimeCompatibilityResult {
  try {
    assertRuntimeVersion();
    return {
      actualVersion: MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
      expectedVersion: MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
      mode: "full-lifecycle",
    };
  } catch (error) {
    if (
      error instanceof McpCredentialBoundaryRuntimeVersionError &&
      error.reason === "version-mismatch"
    ) {
      return {
        actualVersion: error.actualVersion,
        expectedVersion: MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION,
        mode: "expected-version-mismatch",
      };
    }
    throw error;
  }
}

export function recordMcpBridgeRuntimeCompatibility(
  result: McpBridgeRuntimeCompatibilityResult,
  options: {
    artifactDirectory: string;
    githubOutputPath: string;
    githubStepSummaryPath?: string;
    riskSignal?: E2eRiskSignal | null;
  },
): void {
  fs.mkdirSync(options.artifactDirectory, { recursive: true });
  const fullLifecycle = result.mode === "full-lifecycle";
  if (fullLifecycle && options.riskSignal) {
    throw new Error("aligned OpenShell compatibility must defer risk evidence to the live test");
  }
  const artifact = {
    schemaVersion: 1,
    lane: "mcp-bridge-dev",
    artifactKind: "runtime-compatibility-preflight",
    classificationStatus: "passed",
    compatibility: fullLifecycle ? "supported-version" : "unsupported-version",
    mode: result.mode,
    expectedOpenShellVersion: result.expectedVersion,
    actualOpenShellVersion: result.actualVersion,
    credentialBoundaryGate: fullLifecycle ? "accepted" : "rejected-as-required",
    fullLifecycle: fullLifecycle ? "required" : "not-run",
  };
  fs.writeFileSync(
    path.join(options.artifactDirectory, MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  if (options.riskSignal) {
    createPrivateRegularFile(
      path.join(options.artifactDirectory, RISK_SIGNAL_FILE),
      `${JSON.stringify(options.riskSignal, null, 2)}\n`,
    );
  }
  fs.appendFileSync(
    options.githubOutputPath,
    [
      `mode=${result.mode}`,
      `expected_version=${result.expectedVersion}`,
      `actual_version=${result.actualVersion}`,
      "",
    ].join("\n"),
    "utf8",
  );
  if (options.githubStepSummaryPath) {
    fs.appendFileSync(
      options.githubStepSummaryPath,
      [
        "## MCP bridge dev compatibility",
        "",
        `- Result: \`${result.mode}\``,
        `- Structured version evidence: \`${MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT}\``,
        `- Full MCP lifecycle: ${fullLifecycle ? "required" : "not run; the exact-version gate rejected the unsupported runtime as required"}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

export function mcpBridgeCompatibilityRiskSignal(
  result: McpBridgeRuntimeCompatibilityResult,
  env: NodeJS.ProcessEnv,
  resolveHead?: (workspace: string) => string,
): E2eRiskSignal | null {
  if (result.mode !== "expected-version-mismatch") return null;
  const environment = configuredRiskSignalEnvironment(env, resolveHead);
  if (!environment) return null;
  if (environment.jobId !== MCP_BRIDGE_DEV_JOB) {
    throw new Error(`MCP dev compatibility risk signal requires ${MCP_BRIDGE_DEV_JOB}`);
  }
  if (!MCP_BRIDGE_DEV_SHARDS.has(environment.shardId)) {
    throw new Error("MCP dev compatibility risk signal requires a reviewed agent shard");
  }
  // This explicit-only lane tests the moving runtime's compatibility boundary.
  // Rejecting an unreviewed version is its passing assertion; credential-bearing
  // lifecycle evidence remains exclusive to the aligned Vitest branch.
  return buildRiskSignal(environment, {
    passed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    unhandledErrors: 0,
    runReason: "passed",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const artifactDirectory = process.env.E2E_ARTIFACT_DIR;
    const githubOutputPath = process.env.GITHUB_OUTPUT;
    if (!artifactDirectory || !githubOutputPath) {
      throw new Error("E2E_ARTIFACT_DIR and GITHUB_OUTPUT are required");
    }
    const result = classifyMcpBridgeRuntimeCompatibility();
    const riskSignal = mcpBridgeCompatibilityRiskSignal(result, process.env);
    recordMcpBridgeRuntimeCompatibility(result, {
      artifactDirectory,
      githubOutputPath,
      githubStepSummaryPath: process.env.GITHUB_STEP_SUMMARY,
      riskSignal,
    });
    if (result.mode === "expected-version-mismatch") {
      console.log(
        "::notice title=OpenShell dev compatibility::The installed OpenShell runtime is outside the reviewed credential boundary; full MCP lifecycle was not run. See the structured compatibility artifact for version evidence.",
      );
    } else {
      console.log(
        "The installed OpenShell runtime matches the reviewed credential boundary; running the full MCP lifecycle.",
      );
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
