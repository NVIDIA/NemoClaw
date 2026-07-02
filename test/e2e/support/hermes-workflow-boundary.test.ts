// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

describe("Hermes E2E workflow boundary", () => {
  it("rejects pinned Hermes Vitest model overrides", () => {
    const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8"));
    workflow.jobs["hermes-e2e"].env.NEMOCLAW_MODEL = "minimaxai/minimax-m2.7";
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    try {
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateE2eWorkflowBoundary(workflowPath)).toContain(
        "hermes-e2e job must use the shared hosted-compatible model default",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
