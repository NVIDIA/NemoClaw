// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract.ts";

const WORKFLOW_PATH = ".github/workflows/nspect-register-managed-images.yaml";
const TRUSTED_CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const TRUSTED_SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";

type RegistrationWorkflow = {
  name: string;
  on: {
    workflow_run: {
      workflows: string[];
      types: string[];
    };
  };
  permissions: Record<string, string>;
  jobs: {
    "prepare-registration": WorkflowJob;
  };
};

function workflow(): RegistrationWorkflow {
  return readYaml<RegistrationWorkflow>(WORKFLOW_PATH);
}

function step(job: WorkflowJob, name: string): WorkflowStep {
  const match = job.steps?.find((candidate) => candidate.name === name);
  expect(match, `missing workflow step ${name}`).toBeDefined();
  return match!;
}

function collectStrings(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(collectStrings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(collectStrings)
        : [];
}

describe("nSpect registration workflow boundary", () => {
  it("keeps registration disabled and binds preparation to one trusted tag publication", () => {
    const value = workflow();
    const job = value.jobs["prepare-registration"];
    const guard = job.if ?? "";

    expect(value.name).toBe("Security / Prepare nSpect Registration");
    expect(value.on).toEqual({
      workflow_run: {
        workflows: ["Images / Publish Base and Managed Images"],
        types: ["completed"],
      },
    });
    expect(value.permissions).toEqual({});
    expect(Object.keys(value.jobs)).toEqual(["prepare-registration"]);
    [
      "vars.NSPECT_REGISTRATION_ENABLED == 'true'",
      "github.run_attempt == 1",
      "github.repository == 'NVIDIA/NemoClaw'",
      "github.event.workflow_run.status == 'completed'",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_repository.full_name == 'NVIDIA/NemoClaw'",
      "github.event.workflow_run.path == '.github/workflows/base-image.yaml'",
      "startsWith(github.event.workflow_run.head_branch, 'v')",
    ].forEach((fragment) => expect(guard).toContain(fragment));
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.permissions).toEqual({ actions: "read", contents: "read" });
    expect(job.concurrency).toEqual({
      group: "nspect-registration-${{ github.event.workflow_run.id }}",
      "cancel-in-progress": false,
    });

    expect(step(job, "Checkout trusted registration controller")).toMatchObject({
      uses: TRUSTED_CHECKOUT,
      with: {
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
      },
    });
    expect(step(job, "Setup Node.js").uses).toBe(TRUSTED_SETUP_NODE);
    expect(step(job, "Download immutable managed-image cohort contract").env).toMatchObject({
      PUBLICATION_HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
      PUBLICATION_RUN_ATTEMPT: "${{ github.event.workflow_run.run_attempt }}",
      PUBLICATION_RUN_ID: "${{ github.event.workflow_run.id }}",
    });
    expect(step(job, "Prepare immutable nSpect registration plan").env).toMatchObject({
      NSPECT_ID: "NSPECT-SQ44-PJFM",
      NSPECT_PROGRAM_VERSION: "dev",
      PUBLICATION_RELEASE: "${{ github.event.workflow_run.head_branch }}",
    });
    expect(collectStrings(job).some((text) => text.includes("secrets."))).toBe(false);
  });
});
