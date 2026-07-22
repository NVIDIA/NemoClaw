// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readOpenShellGatewayAuthContractWorkflow,
  validateOpenShellGatewayAuthContractWorkflow,
  validateOpenShellGatewayAuthContractWorkflowBoundary,
} from "../../../tools/e2e/openshell-gateway-auth-contract-workflow-boundary.mts";

describe("OpenShell gateway auth contract workflow boundary", () => {
  it("accepts the checked-in workflow and rejects explicit-only trust-boundary mutations", () => {
    expect(validateOpenShellGatewayAuthContractWorkflowBoundary()).toEqual([]);

    const workflow = readOpenShellGatewayAuthContractWorkflow();
    const job = workflow.jobs["openshell-gateway-auth-contract"];
    job.if = "${{ always() }}";
    job["runs-on"] = "self-hosted";
    job["timeout-minutes"] = 60;
    job.env = {
      ...job.env,
      DOCKER_GRPC_PROBE_IMAGE: "node:22-trixie-slim",
      E2E_ARTIFACT_DIR: "/tmp/gateway-auth",
      E2E_DEFAULT_ENABLED: "1",
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
    install.run = "bash scripts/install-openshell.sh";

    const prePull = steps.find((step) => step.name === "Pre-pull pinned gateway auth probe image")!;
    prePull.run = "docker pull node:22-trixie-slim";

    const run = steps.find(
      (step) => step.name === "Run OpenShell gateway auth contract live test",
    )!;
    run.env = { GITHUB_TOKEN: "${{ github.token }}" };
    run.run = "npx vitest run --project e2e-live test/e2e/live/other.test.ts";
    steps.splice(steps.indexOf(prePull), 1);
    steps.splice(steps.indexOf(run) + 1, 0, prePull);

    const upload = steps.find(
      (step) => step.name === "Upload OpenShell gateway auth contract artifacts",
    )!;
    upload.if = "success()";

    expect(validateOpenShellGatewayAuthContractWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "openshell-gateway-auth-contract must run only when explicitly selected",
        "openshell-gateway-auth-contract must run on ubuntu-latest",
        "openshell-gateway-auth-contract must retain its 20 minute resource budget",
        "openshell-gateway-auth-contract must set DOCKER_GRPC_PROBE_IMAGE=node:22-trixie-slim@sha256:e6d9a389d34ff9678438af985c9913fbd1eb6ed36e80fea56644f4b4f6dd70ba",
        "openshell-gateway-auth-contract must set E2E_ARTIFACT_DIR=${{ github.workspace }}/e2e-artifacts/live/openshell-gateway-auth-contract",
        "openshell-gateway-auth-contract must set E2E_DEFAULT_ENABLED=0",
        "openshell-gateway-auth-contract must set NEMOCLAW_OPENSHELL_PIN_VERSION to an exact version",
        "openshell-gateway-auth-contract must not expose NVIDIA_API_KEY at job scope",
        "openshell-gateway-auth-contract action 'actions/checkout@v6' must pin a full SHA",
        "openshell-gateway-auth-contract checkout must disable persisted credentials",
        "openshell-gateway-auth-contract must use the reviewed prepare-e2e action",
        "openshell-gateway-auth-contract step 'Install OpenShell CLI' must run: -u DOCKER_CONFIG",
        "openshell-gateway-auth-contract step 'Pre-pull pinned gateway auth probe image' must run: docker pull \"$DOCKER_GRPC_PROBE_IMAGE\"",
        "openshell-gateway-auth-contract live test must not receive workflow credentials",
        "openshell-gateway-auth-contract must always use the reviewed artifact uploader",
        "openshell-gateway-auth-contract step 'Pre-pull pinned gateway auth probe image' must precede 'Run OpenShell gateway auth contract live test'",
      ]),
    );
  });
});
