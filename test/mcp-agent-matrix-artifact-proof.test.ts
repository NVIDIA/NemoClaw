// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertMcpAgentMatrixArtifacts,
  REQUIRED_MCP_AGENT_TEST_IDS,
  writeMcpAgentMatrixProof,
} from "../tools/e2e/assert-mcp-agent-matrix-artifacts.mts";

const directories: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-agent-matrix-"));
  directories.push(root);
  for (const id of REQUIRED_MCP_AGENT_TEST_IDS) {
    const directory = path.join(root, id);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "scenario.json"), `${JSON.stringify({ id })}\n`);
  }
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("MCP agent matrix artifact proof", () => {
  it("records proof only when all three agent lifecycle artifacts exist", () => {
    const root = fixture();
    const output = writeMcpAgentMatrixProof(root);

    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
      requiredTargetResultIds: [],
      requiredTestIds: REQUIRED_MCP_AGENT_TEST_IDS,
      schemaVersion: 1,
      status: "all-required-tests-passed",
    });
  });

  it("rejects a false-green single-agent artifact set", () => {
    const root = fixture();
    fs.rmSync(path.join(root, "mcp-bridge-hermes"), { recursive: true });

    expect(() => assertMcpAgentMatrixArtifacts(root)).toThrow(
      /mcp-bridge-hermes artifact directory/u,
    );
  });

  it("rejects identity drift and symbolic-link artifacts", () => {
    const root = fixture();
    const scenario = path.join(root, "mcp-bridge-deepagents", "scenario.json");
    fs.writeFileSync(scenario, '{"id":"mcp-bridge"}\n');
    expect(() => assertMcpAgentMatrixArtifacts(root)).toThrow(/expected test identity/u);

    fs.rmSync(scenario);
    fs.symlinkSync(path.join(root, "mcp-bridge", "scenario.json"), scenario);
    expect(() => assertMcpAgentMatrixArtifacts(root)).toThrow(/must be a regular file/u);
  });

  it("requires an explicit passed result for additional stateful targets", () => {
    const root = fixture();
    const targetId = "openshell-credential-generation-window";
    const targetDirectory = path.join(root, targetId);
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(
      path.join(targetDirectory, "target-result.json"),
      `${JSON.stringify({ id: targetId, status: "passed" })}\n`,
    );

    expect(assertMcpAgentMatrixArtifacts(root, [targetId]).requiredTargetResultIds).toEqual([
      targetId,
    ]);
    fs.writeFileSync(
      path.join(targetDirectory, "target-result.json"),
      `${JSON.stringify({ id: targetId, status: "skipped" })}\n`,
    );
    expect(() => assertMcpAgentMatrixArtifacts(root, [targetId])).toThrow(
      /does not prove a passed lifecycle/u,
    );
  });
});
