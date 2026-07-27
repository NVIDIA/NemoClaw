// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateRebuildHermesBootstrapBoundary } from "../../../tools/e2e/workflow-boundary.mts";

type JobName = "rebuild-hermes" | "rebuild-hermes-stale-base";
type WorkflowStep = {
  env?: Record<string, unknown>;
  name: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const INSTALL_OPENSHELL =
  "env -u DOCKER_CONFIG -u DOCKERHUB_USERNAME -u DOCKERHUB_TOKEN -u NVIDIA_API_KEY -u NVIDIA_INFERENCE_API_KEY -u GITHUB_TOKEN -u GH_TOKEN bash scripts/install-openshell.sh";

function bootstrapJob(jobName: JobName): {
  env: Record<string, unknown>;
  steps: WorkflowStep[];
} {
  const runStepName =
    jobName === "rebuild-hermes-stale-base"
      ? "Run Hermes stale-base rebuild live test"
      : "Run Hermes rebuild live test";
  return {
    env: { NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js" },
    steps: [
      {
        name: "Prepare E2E workspace",
        uses: "NVIDIA/NemoClaw/.github/actions/prepare-e2e@immutable",
      },
      { name: "Install OpenShell", run: INSTALL_OPENSHELL },
      {
        name: runStepName,
        env: { NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}" },
        run: "OPENSHELL_BIN=openshell tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/rebuild-hermes.test.ts",
      },
    ],
  };
}

describe("Hermes rebuild bootstrap workflow boundary", () => {
  it.each([
    "rebuild-hermes",
    "rebuild-hermes-stale-base",
  ] as const)("%s accepts the pinned credential-free bootstrap (#7144)", (jobName) => {
    expect(validateRebuildHermesBootstrapBoundary(jobName, bootstrapJob(jobName))).toEqual([]);
  });

  it.each([
    "rebuild-hermes",
    "rebuild-hermes-stale-base",
  ] as const)("%s rejects bootstrap trust-boundary drift (#7144)", (jobName) => {
    const job = bootstrapJob(jobName);
    const [prepare, install, run] = job.steps;
    job.env.NEMOCLAW_CLI_BIN = "${{ github.workspace }}/evil/bin/nemoclaw.js";
    prepare.with = { "build-cli": "false" };
    install.env = {
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    };
    install.run = "bash scripts/install-openshell.sh";
    run.env = {
      ...run.env,
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
    };
    run.run =
      "tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/rebuild-hermes.test.ts";
    job.steps = [run, install, prepare];

    const errors = validateRebuildHermesBootstrapBoundary(jobName, job);
    expect(errors).toContain(`${jobName} job must point NEMOCLAW_CLI_BIN at the repo CLI`);
    expect(errors).toContain(
      `${jobName} workspace preparation must use the default checked-out CLI build`,
    );
    expect(errors).toContain(
      "step 'Install OpenShell' run script must include env -u DOCKER_CONFIG",
    );
    expect(errors).toContain(
      "step 'Install OpenShell' run script must include -u NVIDIA_INFERENCE_API_KEY",
    );
    expect(errors).toContain("step 'Install OpenShell' run script must include -u GH_TOKEN");
    expect(errors).toContain(
      `${jobName} step 'Install OpenShell' env must not include NVIDIA_INFERENCE_API_KEY`,
    );
    expect(errors).toContain(`${jobName} step '${run.name}' env must not include NVIDIA_API_KEY`);
    expect(errors).toContain(`step '${run.name}' run script must include OPENSHELL_BIN`);
    expect(errors).toContain(
      `${jobName} must build the CLI before installing OpenShell and running Vitest`,
    );
  });
});
