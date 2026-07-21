// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { expectedSignalShards } from "../tools/e2e/pr-e2e-gate.mts";

const temporaryWorkflowDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryWorkflowDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryE2eWorkflow(source: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-shards-"));
  temporaryWorkflowDirectories.push(directory);
  const workflowPath = path.join(directory, "e2e.yaml");
  fs.writeFileSync(workflowPath, source, "utf8");
  return workflowPath;
}

describe("PR E2E shard policy", () => {
  it("derives Bedrock signal shards from the agent matrix (#6938)", () => {
    expect(expectedSignalShards(["bedrock-runtime-compatible-anthropic"])).toEqual({
      "bedrock-runtime-compatible-anthropic": ["openclaw", "hermes"],
    });
  });

  // source-shape-contract: security -- Malformed matrix shard selectors must fail closed before SHA evidence dispatch
  it("rejects malformed configured matrix shard selectors", () => {
    const workflow = fs.readFileSync(".github/workflows/e2e.yaml", "utf8");
    const shardExpression = "NEMOCLAW_E2E_SHARD: ${{ matrix.mode }}";

    const invalidExpression = temporaryE2eWorkflow(
      workflow.replace(shardExpression, "NEMOCLAW_E2E_SHARD: mode"),
    );
    expect(() => expectedSignalShards(["hermes-inference-switch"], invalidExpression)).toThrow(
      /must name one matrix include field/u,
    );

    const missingField = temporaryE2eWorkflow(
      workflow.replace(shardExpression, "NEMOCLAW_E2E_SHARD: ${{ matrix.missing }}"),
    );
    expect(() => expectedSignalShards(["hermes-inference-switch"], missingField)).toThrow(
      /must name a missing shard/u,
    );

    const nonStringField = temporaryE2eWorkflow(
      workflow.replace(
        "          - mode: hosted\n            sandbox_name: e2e-hermes-inference-switch",
        "          - mode: 1\n            sandbox_name: e2e-hermes-inference-switch",
      ),
    );
    expect(() => expectedSignalShards(["hermes-inference-switch"], nonStringField)).toThrow(
      /must name a mode shard/u,
    );
  });
});
