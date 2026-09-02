// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type OpenShellGatewayAuthContractWorkflow,
  validateOpenShellGatewayAuthContractWorkflow,
} from "../../../tools/e2e/openshell-gateway-auth-contract-workflow-boundary.mts";

function validWorkflow(): OpenShellGatewayAuthContractWorkflow {
  return {
    jobs: {
      "openshell-gateway-auth-contract": {
        env: {
          DOCKER_GRPC_PROBE_IMAGE:
            "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c",
          E2E_ARTIFACT_DIR:
            "${{ github.workspace }}/e2e-artifacts/live/openshell-gateway-auth-contract",
          NEMOCLAW_CANDIDATE_VERSION: "0.0.116",
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_OPENSHELL_PIN_VERSION: "0.0.116",
          NEMOCLAW_RUN_LIVE_E2E: "1",
        },
        if: "${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'openshell-gateway-auth-contract') }}",
        needs: "generate-matrix",
        "runs-on": "ubuntu-latest",
        steps: [
          {
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: { "persist-credentials": false },
          },
          {
            name: "Prepare E2E workspace",
            uses: "NVIDIA/NemoClaw/.github/actions/prepare-e2e@f6304bc25fc35bfaa441c8c2fbfee38f72805a75",
          },
          {
            name: "Install OpenShell CLI",
            run: "env -u DOCKER_CONFIG -u DOCKERHUB_USERNAME -u DOCKERHUB_TOKEN -u NVIDIA_API_KEY -u NVIDIA_INFERENCE_API_KEY -u GITHUB_TOKEN bash scripts/install-openshell.sh",
          },
          {
            name: "Pre-pull pinned gateway auth probe image",
            run: 'docker pull "$DOCKER_GRPC_PROBE_IMAGE"',
          },
          {
            name: "Run OpenShell gateway auth contract live test",
            run: "npx tsx tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/openshell-gateway-auth-source-contract.test.ts",
          },
          {
            id: "artifact_safety",
            if: "always()",
            name: "Validate final OpenShell gateway auth contract artifacts",
            run: 'node --experimental-strip-types --no-warnings tools/e2e/openshell-gateway-auth-artifact-safety.mts "$E2E_ARTIFACT_DIR"',
          },
          {
            if: "${{ always() && steps.artifact_safety.outcome == 'success' && steps.artifact_safety.outputs.approved_path != '' }}",
            name: "Upload OpenShell gateway auth contract artifacts",
            uses: "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
            with: { path: "${{ steps.artifact_safety.outputs.approved_path }}" },
          },
        ],
        "timeout-minutes": 20,
      },
    },
  };
}

describe("OpenShell gateway auth contract workflow boundary", () => {
  it("accepts a valid contract and rejects protected trust-boundary mutations", () => {
    const workflow = validWorkflow();
    expect(validateOpenShellGatewayAuthContractWorkflow(workflow)).toEqual([]);

    const job = workflow.jobs["openshell-gateway-auth-contract"];
    job.if = "${{ always() }}";
    job["runs-on"] = "self-hosted";
    job["timeout-minutes"] = 60;
    job.env = {
      ...job.env,
      DOCKER_GRPC_PROBE_IMAGE: "node:22-trixie-slim",
      E2E_ARTIFACT_DIR: "/tmp/gateway-auth",
      NEMOCLAW_CANDIDATE_VERSION: "latest",
      NEMOCLAW_OPENSHELL_PIN_VERSION: "latest",
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
    };

    const steps = job.steps!;
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    checkout.uses = "actions/checkout@v6";
    checkout.with!["persist-credentials"] = true;

    const prepare = steps.find((step) => step.name === "Prepare E2E workspace")!;
    prepare.uses = "./.github/actions/prepare-e2e";

    const install = steps.find((step) => step.name === "Install OpenShell CLI")!;
    install.run = "bash tools/e2e/unreviewed-installer.sh";

    const prePull = steps.find((step) => step.name === "Pre-pull pinned gateway auth probe image")!;
    prePull.run = "docker pull node:22-trixie-slim";

    const run = steps.find(
      (step) => step.name === "Run OpenShell gateway auth contract live test",
    )!;
    run.env = { GITHUB_TOKEN: "${{ github.token }}" };
    run.run = "npx vitest run --project e2e-live test/e2e/live/other.test.ts";

    const artifactSafety = steps.find(
      (step) => step.name === "Validate final OpenShell gateway auth contract artifacts",
    )!;
    artifactSafety.id = "unsafe_scan";
    artifactSafety.if = "success()";
    artifactSafety.run = "true";
    steps.splice(steps.indexOf(prePull), 1);
    steps.splice(steps.indexOf(run) + 1, 0, prePull);

    const upload = steps.find(
      (step) => step.name === "Upload OpenShell gateway auth contract artifacts",
    )!;
    upload.uses = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
    upload.if = "always()";
    upload.with = { path: "e2e-artifacts/live/openshell-gateway-auth-contract/" };
    steps.splice(steps.indexOf(artifactSafety), 1);
    steps.splice(steps.indexOf(upload) + 1, 0, artifactSafety);

    expect(validateOpenShellGatewayAuthContractWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "openshell-gateway-auth-contract must use the trusted execution plan",
        "openshell-gateway-auth-contract must run on ubuntu-latest",
        "openshell-gateway-auth-contract must retain its 20 minute resource budget",
        "openshell-gateway-auth-contract must set DOCKER_GRPC_PROBE_IMAGE=node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c",
        "openshell-gateway-auth-contract must set E2E_ARTIFACT_DIR=${{ github.workspace }}/e2e-artifacts/live/openshell-gateway-auth-contract",
        "openshell-gateway-auth-contract must set NEMOCLAW_CANDIDATE_VERSION=0.0.116",
        "openshell-gateway-auth-contract must set NEMOCLAW_OPENSHELL_PIN_VERSION=0.0.116",
        "openshell-gateway-auth-contract must not expose NVIDIA_API_KEY at job scope",
        "openshell-gateway-auth-contract action 'actions/checkout@v6' must pin a full SHA",
        "openshell-gateway-auth-contract checkout must disable persisted credentials",
        "openshell-gateway-auth-contract must use the reviewed prepare-e2e action",
        "openshell-gateway-auth-contract must run only the canonical credential-free OpenShell install",
        "openshell-gateway-auth-contract step 'Pre-pull pinned gateway auth probe image' must run: docker pull \"$DOCKER_GRPC_PROBE_IMAGE\"",
        "openshell-gateway-auth-contract live test must not receive workflow credentials",
        "openshell-gateway-auth-contract final artifact safety scan must run unconditionally with a stable id",
        "openshell-gateway-auth-contract step 'Validate final OpenShell gateway auth contract artifacts' must run exactly: node --experimental-strip-types --no-warnings tools/e2e/openshell-gateway-auth-artifact-safety.mts \"$E2E_ARTIFACT_DIR\"",
        "openshell-gateway-auth-contract must use the reviewed artifact uploader",
        "openshell-gateway-auth-contract must upload artifacts only after this run attempt passes safety scan",
        "openshell-gateway-auth-contract must upload only the immutable approved artifact payload",
        "openshell-gateway-auth-contract step 'Pre-pull pinned gateway auth probe image' must precede 'Run OpenShell gateway auth contract live test'",
        "openshell-gateway-auth-contract step 'Validate final OpenShell gateway auth contract artifacts' must precede 'Upload OpenShell gateway auth contract artifacts'",
      ]),
    );
  });

  it("rejects artifact safety commands that can mask scanner failures (#7101)", () => {
    const workflow = validWorkflow();
    const artifactSafety = workflow.jobs["openshell-gateway-auth-contract"].steps!.find(
      (step) => step.name === "Validate final OpenShell gateway auth contract artifacts",
    )!;
    artifactSafety.run = `${artifactSafety.run} || true`;

    expect(validateOpenShellGatewayAuthContractWorkflow(workflow)).toContain(
      "openshell-gateway-auth-contract step 'Validate final OpenShell gateway auth contract artifacts' must run exactly: node --experimental-strip-types --no-warnings tools/e2e/openshell-gateway-auth-artifact-safety.mts \"$E2E_ARTIFACT_DIR\"",
    );
  });
});
