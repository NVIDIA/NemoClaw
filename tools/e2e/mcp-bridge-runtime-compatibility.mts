// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as importedMcpBridgeValidation from "../../src/lib/actions/sandbox/mcp-bridge-validation.ts";

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

export const MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT = "openshell-runtime-compatibility.json";

export type McpBridgeRuntimeCompatibilityMode = "expected-version-mismatch" | "full-lifecycle";

export interface McpBridgeRuntimeCompatibilityResult {
  actualVersion: string;
  expectedVersion: string;
  guardMessage?: string;
  mode: McpBridgeRuntimeCompatibilityMode;
}

type AssertRuntimeVersion = () => void;

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
        guardMessage: error.message,
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
  },
): void {
  fs.mkdirSync(options.artifactDirectory, { recursive: true });
  const fullLifecycle = result.mode === "full-lifecycle";
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
    ...(result.guardMessage ? { guardMessage: result.guardMessage } : {}),
  };
  fs.writeFileSync(
    path.join(options.artifactDirectory, MCP_BRIDGE_RUNTIME_COMPATIBILITY_ARTIFACT),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
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
        `- Reviewed OpenShell version: \`${result.expectedVersion}\``,
        `- Installed OpenShell version: \`${result.actualVersion}\``,
        `- Full MCP lifecycle: ${fullLifecycle ? "required" : "not run; the exact-version gate rejected the unsupported runtime as required"}`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const artifactDirectory = process.env.E2E_ARTIFACT_DIR;
    const githubOutputPath = process.env.GITHUB_OUTPUT;
    if (!artifactDirectory || !githubOutputPath) {
      throw new Error("E2E_ARTIFACT_DIR and GITHUB_OUTPUT are required");
    }
    const result = classifyMcpBridgeRuntimeCompatibility();
    recordMcpBridgeRuntimeCompatibility(result, {
      artifactDirectory,
      githubOutputPath,
      githubStepSummaryPath: process.env.GITHUB_STEP_SUMMARY,
    });
    if (result.mode === "expected-version-mismatch") {
      console.log(
        `::notice title=OpenShell dev compatibility::Unsupported OpenShell ${result.actualVersion} was rejected by the reviewed ${result.expectedVersion} credential boundary; full MCP lifecycle was not run.`,
      );
    } else {
      console.log(
        `OpenShell ${result.actualVersion} matches the reviewed credential boundary; running the full MCP lifecycle.`,
      );
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
