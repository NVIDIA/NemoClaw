// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  loadQualificationProducerWorkflow,
  qualificationProducerRuntimePaths,
  validateQualificationProducerWorkflow,
} from "../scripts/checks/verify-openshell-qualification-producer-workflow.mts";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("test fixture value is not an object");
  }
  return value as JsonRecord;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("test fixture value is not an array");
  return value;
}

function cloneWorkflow(): JsonRecord {
  return record(structuredClone(loadQualificationProducerWorkflow()));
}

function receiptJob(workflow: JsonRecord): JsonRecord {
  return record(record(workflow.jobs).receipt);
}

function steps(workflow: JsonRecord): JsonRecord[] {
  return array(receiptJob(workflow).steps).map(record);
}

function step(workflow: JsonRecord, index: number): JsonRecord {
  const selected = steps(workflow)[index];
  if (!selected) throw new Error(`missing test fixture step ${index}`);
  return selected;
}

const mutations: ReadonlyArray<{
  name: string;
  mutate: (workflow: JsonRecord) => void;
}> = [
  {
    name: "dispatch input schema",
    mutate(workflow) {
      const dispatch = record(record(workflow.on).workflow_dispatch);
      record(record(dispatch.inputs).candidate_sha).type = "choice";
    },
  },
  {
    name: "read-only permissions",
    mutate(workflow) {
      record(workflow.permissions).contents = "write";
    },
  },
  {
    name: "job-level permission override",
    mutate(workflow) {
      receiptJob(workflow).permissions = { contents: "write" };
    },
  },
  {
    name: "main repository guard",
    mutate(workflow) {
      receiptJob(workflow).if = "github.ref == 'refs/heads/main'";
    },
  },
  {
    name: "concurrency cancellation",
    mutate(workflow) {
      record(workflow.concurrency)["cancel-in-progress"] = false;
    },
  },
  {
    name: "pinned setup action",
    mutate(workflow) {
      step(workflow, 0).uses = "actions/setup-node@v7";
    },
  },
  {
    name: "step control surface",
    mutate(workflow) {
      step(workflow, 0)["continue-on-error"] = true;
    },
  },
  {
    name: "authentication environment",
    mutate(workflow) {
      record(step(workflow, 1).env).NODE_OPTIONS = "--import .candidate/attack.mjs";
    },
  },
  {
    name: "authentication-before-checkout ordering",
    mutate(workflow) {
      const workflowSteps = array(receiptJob(workflow).steps);
      [workflowSteps[1], workflowSteps[2]] = [workflowSteps[2], workflowSteps[1]];
    },
  },
  {
    name: "base-trusted checkout ref",
    mutate(workflow) {
      record(step(workflow, 2).with).ref = "${{ inputs.candidate_sha }}";
    },
  },
  {
    name: "base-trusted runtime import closure",
    mutate(workflow) {
      record(step(workflow, 2).with)["sparse-checkout"] = qualificationProducerRuntimePaths()
        .slice(1)
        .join("\n");
    },
  },
  {
    name: "base-trusted checkout inputs",
    mutate(workflow) {
      record(step(workflow, 2).with).repository = "attacker/fork";
    },
  },
  {
    name: "base-trusted credential persistence",
    mutate(workflow) {
      record(step(workflow, 2).with)["persist-credentials"] = true;
    },
  },
  {
    name: "candidate checkout ref",
    mutate(workflow) {
      record(step(workflow, 3).with).ref = "${{ inputs.base_sha }}";
    },
  },
  {
    name: "candidate contract-only checkout",
    mutate(workflow) {
      record(step(workflow, 3).with)["sparse-checkout"] =
        "ci/openshell-0.0.101-qualification-v1.json\nscripts/release-cut-tag.sh";
    },
  },
  {
    name: "candidate working directory",
    mutate(workflow) {
      step(workflow, 3)["working-directory"] = ".candidate-openshell-qualification";
    },
  },
  {
    name: "candidate credential persistence",
    mutate(workflow) {
      record(step(workflow, 3).with)["persist-credentials"] = true;
    },
  },
  {
    name: "producer environment",
    mutate(workflow) {
      record(step(workflow, 4).env).NODE_OPTIONS = "--import .candidate/attack.mjs";
    },
  },
  {
    name: "producer program",
    mutate(workflow) {
      step(workflow, 4).run = `${String(step(workflow, 4).run)}\necho bypass`;
    },
  },
  {
    name: "producer-consumer ordering",
    mutate(workflow) {
      const workflowSteps = array(receiptJob(workflow).steps);
      [workflowSteps[4], workflowSteps[5]] = [workflowSteps[5], workflowSteps[4]];
    },
  },
  {
    name: "consumer environment",
    mutate(workflow) {
      record(step(workflow, 5).env).NODE_OPTIONS = "--import .candidate/attack.mjs";
    },
  },
  {
    name: "consumer program",
    mutate(workflow) {
      step(workflow, 5).run = `${String(step(workflow, 5).run)}\necho bypass`;
    },
  },
  {
    name: "pinned artifact action",
    mutate(workflow) {
      step(workflow, 6).uses = "actions/upload-artifact@v7";
    },
  },
  {
    name: "artifact name",
    mutate(workflow) {
      record(step(workflow, 6).with).name = "qualification";
    },
  },
  {
    name: "artifact retention",
    mutate(workflow) {
      record(step(workflow, 6).with)["retention-days"] = 1;
    },
  },
  {
    name: "artifact compression",
    mutate(workflow) {
      record(step(workflow, 6).with)["compression-level"] = 9;
    },
  },
  {
    name: "contract-only matrix ownership",
    mutate(workflow) {
      step(workflow, 1).run = `${String(step(workflow, 1).run)}\n# openshell-00101-forged`;
    },
  },
  {
    name: "single reviewed job",
    mutate(workflow) {
      record(workflow.jobs).attacker = { "runs-on": "ubuntu-latest", steps: [] };
    },
  },
];

describe("OpenShell qualification producer workflow boundary", () => {
  it("accepts the shipped base-trusted producer workflow (#8600)", () => {
    expect(() => validateQualificationProducerWorkflow(cloneWorkflow())).not.toThrow();
  });

  it.each(mutations)("rejects a changed $name (#8600)", ({ mutate }) => {
    const workflow = cloneWorkflow();
    mutate(workflow);
    expect(() => validateQualificationProducerWorkflow(workflow)).toThrow(
      "OpenShell qualification producer workflow check failed",
    );
  });
});
