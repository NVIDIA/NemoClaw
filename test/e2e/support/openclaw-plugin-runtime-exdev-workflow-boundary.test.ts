// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type OpenClawPluginRuntimeExdevWorkflow,
  validateOpenClawPluginRuntimeExdevWorkflow,
} from "../../../tools/e2e/openclaw-plugin-runtime-exdev-workflow-boundary.mts";

const JOB_NAME = "openclaw-plugin-runtime-exdev";
const BUILDER_IMAGE =
  "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c";

function validWorkflow(): OpenClawPluginRuntimeExdevWorkflow {
  const expression = (value: string) => "${{ " + value + " }}";
  return {
    jobs: {
      [JOB_NAME]: {
        needs: "generate-matrix",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 85,
        permissions: { contents: "read" },
        env: {
          E2E_ARTIFACT_DIR: expression("github.workspace") + "/e2e-artifacts/live/" + JOB_NAME,
          E2E_TARGET_ID: JOB_NAME,
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
          NEMOCLAW_CLI_BIN: expression("github.workspace") + "/bin/nemoclaw.js",
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_RUN_LIVE_E2E: "1",
          NEMOCLAW_SANDBOX_NAME: "e2e-oc-exdev",
          OPENSHELL_GATEWAY: "nemoclaw",
        },
        steps: [
          {
            name: "Checkout candidate",
            uses: "actions/checkout@de0fac2e4500dabe000000000000000000000000",
            with: { "persist-credentials": false },
          },
          {
            name: "Authenticate to Docker Hub",
            uses: "NVIDIA/NemoClaw/.github/actions/docker-auth-setup@05fa6b810017752ab21148cb7e9d82d12a88c92f",
          },
          {
            name: "Pre-pull current-checkout Docker Hub builder image",
            run: "docker pull " + BUILDER_IMAGE,
          },
          {
            name: "Remove Docker auth before current-checkout fixture",
            if: "always()",
            uses: "NVIDIA/NemoClaw/.github/actions/docker-auth-cleanup@d5f37099766ca82a4516e7d8f0de117cda197fe3",
          },
          {
            name: "Prepare E2E workspace",
            uses: "NVIDIA/NemoClaw/.github/actions/prepare-e2e@f6304bc25fc35bfaa441c8c2fbfee38f72805a75",
          },
          {
            name: "Run OpenClaw cross-device plugin lifecycle live test",
            run: [
              'test -n "${DOCKER_CONFIG:-}"',
              'test ! -e "${DOCKER_CONFIG}"',
              'test -z "${DOCKERHUB_USERNAME:-}"',
              'test -z "${DOCKERHUB_TOKEN:-}"',
              "env -u DOCKER_CONFIG -u DOCKERHUB_USERNAME -u DOCKERHUB_TOKEN",
              "tools/e2e/live-vitest-invocation.mts run",
              "--test-path test/e2e/live/openclaw-plugin-runtime-exdev.test.ts",
              "--selector current-lifecycle",
            ].join("\n"),
          },
          {
            name: "Upload OpenClaw cross-device plugin lifecycle artifacts",
            if: "always()",
            uses: "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
          },
        ],
      },
    },
  };
}
describe("OpenClaw plugin runtime EXDEV workflow boundary", () => {
  it("rejects arbitrary work while Docker Hub credentials are live", () => {
    const workflow = validWorkflow();
    expect(validateOpenClawPluginRuntimeExdevWorkflow(workflow)).toEqual([]);
    const steps = workflow.jobs[JOB_NAME].steps!;
    const revokeIndex = steps.findIndex(
      (step) => step.name === "Remove Docker auth before current-checkout fixture",
    );
    steps.splice(revokeIndex, 0, {
      name: "Read Docker credentials",
      run: 'cat "$DOCKER_CONFIG/config.json"',
    });

    expect(validateOpenClawPluginRuntimeExdevWorkflow(workflow)).toContain(
      "openclaw-plugin-runtime-exdev step 'Pre-pull current-checkout Docker Hub builder image' must immediately precede 'Remove Docker auth before current-checkout fixture'",
    );
  });

  it("rejects trust-boundary mutations", () => {
    const workflow = validWorkflow();
    expect(validateOpenClawPluginRuntimeExdevWorkflow(workflow)).toEqual([]);
    const job = workflow.jobs[JOB_NAME];
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
      (step) => step.name === "Pre-pull current-checkout Docker Hub builder image",
    )!;
    prePull.run = "docker pull node:22-trixie-slim";

    const revokeIndex = steps.findIndex(
      (step) => step.name === "Remove Docker auth before current-checkout fixture",
    );
    const [revoke] = steps.splice(revokeIndex, 1);
    revoke!.if = "success()";
    revoke!.uses = "./.github/actions/docker-auth-cleanup";
    revoke!.run = "echo credentials retained";
    steps.splice(steps.indexOf(prepare) + 1, 0, revoke!);

    const run = steps.find(
      (step) => step.name === "Run OpenClaw cross-device plugin lifecycle live test",
    )!;
    run.env = { DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}" };
    run.run = "npx vitest run --project e2e-live test/e2e/live/other.test.ts";

    const upload = steps.find(
      (step) => step.name === "Upload OpenClaw cross-device plugin lifecycle artifacts",
    )!;
    upload.if = "success()";

    expect(validateOpenClawPluginRuntimeExdevWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "openclaw-plugin-runtime-exdev must run on ubuntu-latest",
        "openclaw-plugin-runtime-exdev must retain its 85 minute runtime proof budget",
        "openclaw-plugin-runtime-exdev must hold only contents: read",
        "openclaw-plugin-runtime-exdev must set E2E_ARTIFACT_DIR=${{ github.workspace }}/e2e-artifacts/live/openclaw-plugin-runtime-exdev",
        "openclaw-plugin-runtime-exdev must remain enabled for scheduled and empty manual runs",
        "openclaw-plugin-runtime-exdev must not expose NVIDIA_INFERENCE_API_KEY at job scope",
        "openclaw-plugin-runtime-exdev action 'Checkout candidate' must pin a full SHA",
        "openclaw-plugin-runtime-exdev checkout must disable persisted credentials",
        "openclaw-plugin-runtime-exdev must use the reviewed prepare-e2e action",
        "openclaw-plugin-runtime-exdev step 'Pre-pull current-checkout Docker Hub builder image' must run: docker pull node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c",
        "openclaw-plugin-runtime-exdev must always revoke Docker auth before the current-checkout fixture",
        "openclaw-plugin-runtime-exdev must use the pinned Docker auth cleanup action before artifact restore",
        "openclaw-plugin-runtime-exdev runtime proof must not receive workflow credentials",
        "openclaw-plugin-runtime-exdev must always use the reviewed artifact uploader",
        "openclaw-plugin-runtime-exdev step 'Remove Docker auth before current-checkout fixture' must precede 'Prepare E2E workspace'",
      ]),
    );
  });
});
