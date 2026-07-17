// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_MCP_AGENT_TEST_IDS = [
  "mcp-bridge",
  "mcp-bridge-hermes",
  "mcp-bridge-deepagents",
] as const;

export interface McpAgentMatrixProof {
  requiredTargetResultIds: readonly string[];
  requiredTestIds: typeof REQUIRED_MCP_AGENT_TEST_IDS;
  schemaVersion: 1;
  status: "all-required-tests-passed";
}

function requireDirectory(target: string, label: string): void {
  if (!fs.existsSync(target)) {
    throw new Error(`${label} is missing: ${target}`);
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${target}`);
  }
}

function requireRegularFile(target: string, label: string): void {
  if (!fs.existsSync(target)) {
    throw new Error(`${label} is missing: ${target}`);
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${target}`);
  }
}

export function assertMcpAgentMatrixArtifacts(
  rootDirectory: string,
  requiredTargetResultIds: readonly string[] = [],
): McpAgentMatrixProof {
  const root = path.resolve(rootDirectory);
  requireDirectory(root, "MCP artifact root");

  const uniqueTargetIds = [...new Set(requiredTargetResultIds)];
  if (
    uniqueTargetIds.length !== requiredTargetResultIds.length ||
    uniqueTargetIds.some((id) => !/^[a-z0-9][a-z0-9._-]*$/u.test(id))
  ) {
    throw new Error("required target result IDs must be unique safe artifact identifiers");
  }

  for (const testId of REQUIRED_MCP_AGENT_TEST_IDS) {
    const testDirectory = path.join(root, testId);
    requireDirectory(testDirectory, `${testId} artifact directory`);
    const scenarioPath = path.join(testDirectory, "scenario.json");
    requireRegularFile(scenarioPath, `${testId} scenario artifact`);
    const scenario: unknown = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
    if (
      scenario === null ||
      typeof scenario !== "object" ||
      Array.isArray(scenario) ||
      (scenario as { id?: unknown }).id !== testId
    ) {
      throw new Error(`${testId} scenario artifact does not prove the expected test identity`);
    }
  }

  for (const targetId of uniqueTargetIds) {
    const targetDirectory = path.join(root, targetId);
    requireDirectory(targetDirectory, `${targetId} artifact directory`);
    const resultPath = path.join(targetDirectory, "target-result.json");
    requireRegularFile(resultPath, `${targetId} target result`);
    const result: unknown = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    if (
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      (result as { id?: unknown }).id !== targetId ||
      (result as { status?: unknown }).status !== "passed"
    ) {
      throw new Error(`${targetId} target result does not prove a passed lifecycle`);
    }
  }

  return {
    requiredTargetResultIds: uniqueTargetIds,
    requiredTestIds: REQUIRED_MCP_AGENT_TEST_IDS,
    schemaVersion: 1,
    status: "all-required-tests-passed",
  };
}

export function writeMcpAgentMatrixProof(
  rootDirectory: string,
  requiredTargetResultIds: readonly string[] = [],
): string {
  const proof = assertMcpAgentMatrixArtifacts(rootDirectory, requiredTargetResultIds);
  const output = path.join(path.resolve(rootDirectory), "mcp-agent-matrix-proof.json");
  fs.writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = process.argv[2];
    if (!root) {
      throw new Error(
        "Usage: npx tsx tools/e2e/assert-mcp-agent-matrix-artifacts.mts ARTIFACT_DIR [TARGET_RESULT_ID ...]",
      );
    }
    const output = writeMcpAgentMatrixProof(root, process.argv.slice(3));
    console.log(`MCP agent matrix artifact proof written: ${output}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
