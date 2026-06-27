// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eVitestScenariosWorkflowBoundary } from "../../../tools/e2e-scenarios/workflow-boundary.mts";

describe("gateway guard workflow boundary", () => {
  it("rejects missing hosted-compatible inference mode", () => {
    const workflow = YAML.parse(
      fs.readFileSync(".github/workflows/e2e-vitest-scenarios.yaml", "utf8"),
    );
    delete workflow.jobs["gateway-guard-recovery"].env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gateway-guard-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    try {
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toContain(
        "gateway-guard-recovery job must enable hosted-compatible inference mode",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
