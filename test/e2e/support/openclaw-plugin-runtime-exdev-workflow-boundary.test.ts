// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readOpenClawPluginRuntimeExdevWorkflow,
  validateOpenClawPluginRuntimeExdevWorkflow,
  validateOpenClawPluginRuntimeExdevWorkflowBoundary,
} from "../../../tools/e2e/openclaw-plugin-runtime-exdev-workflow-boundary.mts";

describe("OpenClaw plugin runtime EXDEV workflow boundary", () => {
  it("rejects arbitrary work while Docker Hub credentials are live", () => {
    const workflow = readOpenClawPluginRuntimeExdevWorkflow();
    const steps = workflow.jobs["openclaw-plugin-runtime-exdev"].steps!;
    const revokeIndex = steps.findIndex(
      (step) => step.name === "Remove Docker auth before release-pinned fixture",
    );
    steps.splice(revokeIndex, 0, {
      name: "Read Docker credentials",
      run: 'cat "$DOCKER_CONFIG/config.json"',
    });

    expect(validateOpenClawPluginRuntimeExdevWorkflow(workflow)).toContain(
      "openclaw-plugin-runtime-exdev step 'Pre-pull release-matched Docker Hub builder image' must immediately precede 'Remove Docker auth before release-pinned fixture'",
    );
  });

  it("accepts the checked-in workflow and rejects trust-boundary mutations", () => {
    expect(validateOpenClawPluginRuntimeExdevWorkflowBoundary()).toEqual([]);

    const workflow = readOpenClawPluginRuntimeExdevWorkflow();
    const job = workflow.jobs["openclaw-plugin-runtime-exdev"];
    job["runs-on"] = "self-hosted";
    job["timeout-minutes"] = 60;
    job.permissions = { contents: "write" };
    job.env = {
      ...job.env,
      E2E_ARTIFACT_DIR: "/tmp/openclaw-plugin-runtime-exdev",
      E2E_DEFAULT_ENABLED: "0",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    };

    const steps = job.steps!;
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    checkout.uses = "actions/checkout@v6";
    checkout.with!["persist-credentials"] = true;

    const prepare = steps.find((step) => step.name === "Prepare E2E workspace")!;
    prepare.uses = "./.github/actions/prepare-e2e";

    const prePull = steps.find(
      (step) => step.name === "Pre-pull release-matched Docker Hub builder image",
    )!;
    prePull.run = "docker pull node:22-trixie-slim";

    const revokeIndex = steps.findIndex(
      (step) => step.name === "Remove Docker auth before release-pinned fixture",
    );
    const [revoke] = steps.splice(revokeIndex, 1);
    revoke!.if = "success()";
    revoke!.run = "echo credentials retained";
    steps.splice(steps.indexOf(prepare) + 1, 0, revoke!);

    const run = steps.find(
      (step) =>
        step.name === "Run OpenClaw custom-plugin lifecycle and runtime-deps EXDEV live test",
    )!;
    run.env = { DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}" };
    run.run = "npx vitest run --project e2e-live test/e2e/live/other.test.ts";

    const upload = steps.find(
      (step) => step.name === "Upload OpenClaw plugin runtime-deps EXDEV artifacts",
    )!;
    upload.if = "success()";

    expect(validateOpenClawPluginRuntimeExdevWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "openclaw-plugin-runtime-exdev must run on ubuntu-latest",
        "openclaw-plugin-runtime-exdev must retain its 130 minute runtime proof budget",
        "openclaw-plugin-runtime-exdev must hold only contents: read",
        "openclaw-plugin-runtime-exdev must set E2E_ARTIFACT_DIR=${{ github.workspace }}/e2e-artifacts/live/openclaw-plugin-runtime-exdev",
        "openclaw-plugin-runtime-exdev must remain enabled for scheduled and empty manual runs",
        "openclaw-plugin-runtime-exdev must not expose NVIDIA_INFERENCE_API_KEY at job scope",
        "openclaw-plugin-runtime-exdev action 'actions/checkout@v6' must pin a full SHA",
        "openclaw-plugin-runtime-exdev checkout must disable persisted credentials",
        "openclaw-plugin-runtime-exdev must use the reviewed prepare-e2e action",
        "openclaw-plugin-runtime-exdev step 'Pre-pull release-matched Docker Hub builder image' must run: docker pull node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba",
        "openclaw-plugin-runtime-exdev must always revoke Docker auth before the release-pinned fixture",
        "openclaw-plugin-runtime-exdev step 'Remove Docker auth before release-pinned fixture' must run: bash .github/scripts/docker-auth-cleanup.sh",
        "openclaw-plugin-runtime-exdev runtime proof must not receive workflow credentials",
        "openclaw-plugin-runtime-exdev must always use the reviewed artifact uploader",
        "openclaw-plugin-runtime-exdev step 'Remove Docker auth before release-pinned fixture' must precede 'Prepare E2E workspace'",
      ]),
    );
  });
});
