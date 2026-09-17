// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  discoverCredentialFreeTests,
  stripCredentialFreeTestDeclarations,
} from "../../../tools/e2e/credential-free-tests.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import { testTimeoutOptions } from "../../helpers/timeouts";

type Workflow = {
  jobs: Record<
    string,
    {
      env?: Record<string, unknown>;
      needs?: string[];
      steps?: Array<{ name?: string; run?: string; with?: Record<string, unknown> }>;
    }
  >;
};

function validateMutatedWorkflow(mutator: (workflow: Workflow) => void): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shared-e2e-workflow-"));
  const workflowPath = path.join(directory, "workflow.yaml");
  const workflow = readWorkflow() as Workflow;
  try {
    mutator(workflow);
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

describe("shared E2E workflow boundary", () => {
  it("reconciles workflow markers without letting them change planned execution ownership", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      delete workflow.jobs["openshell-gateway-auth-contract"];
      workflow.jobs["unregistered-proof"] = {
        env: { E2E_JOB: "1", E2E_TARGET_ID: "unregistered-proof" },
        steps: [
          {
            run: "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/unregistered-proof.test.ts",
          },
        ],
      };
    });
    expect(errors).toContain("Registered workflow job openshell-gateway-auth-contract is missing");
    expect(errors).toContain(
      "Discovered workflow job unregistered-proof has no inventory disposition",
    );
    expect(() => buildE2eWorkflowPlan({ jobs: "unregistered-proof" })).toThrow(
      "unregistered-proof",
    );
  });

  it.each(["", "dockre", "docker,docker", "docker,", 7, null])(
    "rejects an explicitly invalid gateway runtime declaration: %s",
    (declaration) => {
      const errors = validateMutatedWorkflow((workflow) => {
        workflow.jobs["openshell-gateway-auth-contract"].env!.E2E_GATEWAY_RUNTIMES = declaration;
      });
      expect(errors).toContain(
        "openshell-gateway-auth-contract job E2E_GATEWAY_RUNTIMES is invalid",
      );
    },
  );

  it("keeps runtime-agnostic free-standing jobs valid when no declaration exists", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      delete workflow.jobs["openshell-gateway-auth-contract"].env!.E2E_GATEWAY_RUNTIMES;
    });
    expect(errors).not.toContain(
      "openshell-gateway-auth-contract job E2E_GATEWAY_RUNTIMES is invalid",
    );
  });

  it.each([
    ["22.19.0", "jetson-nvmap-gpu", "Set up Node for Jetson controller"],
    ["22.19.0", "generate-matrix", "Set up Node for trusted E2E planning"],
    ["22.19.0", "base-image-publication", "Set up Node for publication verification"],
    ["22.19.0", "hermes-gpu-startup", "Reassert trusted Node runtime"],
    ["^22.19.0", "jetson-nvmap-gpu", "Set up Node for Jetson controller"],
    ["^22.19.0", "generate-matrix", "Set up Node for trusted E2E planning"],
    ["^22.19.0", "base-image-publication", "Set up Node for publication verification"],
    ["^22.19.0", "hermes-gpu-startup", "Reassert trusted Node runtime"],
  ])("accepts the compatible Node selector %s in %s (%s)", (version, job, stepName) => {
    const errors = validateMutatedWorkflow((workflow) => {
      const step = workflow.jobs[job].steps!.find((candidate) => candidate.name === stepName)!;
      step.with!["node-version"] = version;
    });
    expect(errors).toEqual([]);
  });

  it(
    "keeps every tagged credential-free test visible to Vitest discovery",
    testTimeoutOptions(15_000),
    () => {
      const declaredFiles = fs
        .globSync(["**/*.test.js", "**/*.test.ts"], {
          cwd: process.cwd(),
          exclude: ["**/dist/**", "**/node_modules/**"],
        })
        .filter((file) => {
          const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
          return stripCredentialFreeTestDeclarations(source) !== source;
        })
        .sort();

      expect(
        discoverCredentialFreeTests()
          .map(({ file }) => file)
          .sort(),
      ).toEqual(declaredFiles);
    },
  );

  it("ratchets shared setup, tagged test execution, and aggregation", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const job = workflow.jobs["shared-e2e"];
      job.env!.CHECK_DOC_LINKS_REMOTE = "1";
      job.steps!.find((step) => step.name === "Run tagged credential-free test")!.run =
        "echo skipped";
      workflow.jobs["report-to-pr"].needs = workflow.jobs["report-to-pr"].needs!.filter(
        (name) => name !== "shared-e2e",
      );
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "shared E2E job must set CHECK_DOC_LINKS_REMOTE to 0",
        'step \'Run tagged credential-free test\' run script must include npx vitest run --project "${TEST_PROJECT}" "${TEST_FILE}"',
        "step 'Run tagged credential-free test' run script must include --tags-filter=e2e/credential-free",
        "report-to-pr job must wait for shared-e2e",
      ]),
    );
  });

  it("reports a missing shared job as a contract error", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      delete workflow.jobs["shared-e2e"];
    });

    expect(errors).toContain("workflow missing shared E2E job");
  });
});
