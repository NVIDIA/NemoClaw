// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml } from "./helpers/e2e-workflow-contract";

type ReusableCallerJob = {
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
};

type Workflow = {
  on?: {
    workflow_call?: {
      inputs?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
    };
    workflow_dispatch?: {
      inputs?: Record<string, unknown>;
    };
  };
  jobs?: Record<string, ReusableCallerJob>;
};

describe("Brev nightly workflow contract", () => {
  const nightly = readYaml<Workflow>(".github/workflows/brev-nightly-e2e.yaml");
  const branchValidation = readYaml<Workflow>(".github/workflows/e2e-branch-validation.yaml");

  it("passes only declared inputs and secrets to branch validation", () => {
    const declaredInputs = new Set(Object.keys(branchValidation.on?.workflow_call?.inputs ?? {}));
    const declaredSecrets = new Set(Object.keys(branchValidation.on?.workflow_call?.secrets ?? {}));
    const callerJobs = Object.entries(nightly.jobs ?? {}).filter(
      ([, job]) => job.uses === "./.github/workflows/e2e-branch-validation.yaml",
    );

    expect(callerJobs.length).toBeGreaterThan(0);
    for (const [jobName, job] of callerJobs) {
      const unknownInputs = Object.keys(job.with ?? {}).filter((name) => !declaredInputs.has(name));
      const unknownSecrets = Object.keys(job.secrets ?? {}).filter((name) => !declaredSecrets.has(name));

      expect(unknownInputs, `${jobName} passes unsupported reusable workflow inputs`).toEqual([]);
      expect(unknownSecrets, `${jobName} passes unsupported reusable workflow secrets`).toEqual([]);
    }
  });

  it("does not expose stale published-launchable controls", () => {
    const dispatchInputs = Object.keys(nightly.on?.workflow_dispatch?.inputs ?? {});
    const callerInputs = Object.values(nightly.jobs ?? {}).flatMap((job) => Object.keys(job.with ?? {}));

    expect(dispatchInputs).not.toContain("launchable_id");
    expect(callerInputs).not.toContain("launchable_id");
    expect(callerInputs).not.toContain("use_published_launchable");
  });
});
