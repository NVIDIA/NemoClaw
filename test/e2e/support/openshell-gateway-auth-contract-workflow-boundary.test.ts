// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  readOpenShellGatewayAuthContractWorkflow,
  validateOpenShellGatewayAuthContractWorkflow,
  validateOpenShellGatewayAuthContractWorkflowBoundary,
} from "../../../tools/e2e/openshell-gateway-auth-contract-workflow-boundary.mts";

describe("OpenShell gateway auth contract workflow boundary", () => {
  it("binds the qualification installer to one coherent OpenShell 0.0.106 release", () => {
    const installerPath = "tools/e2e/install-openshell-v00106-qualification.sh";
    const source = readFileSync(installerPath, "utf8");
    const identities = [
      [
        "openshell-x86_64-unknown-linux-musl.tar.gz",
        "d1a885a91b3e5aaa006c36aca95dc78bed0638c1ba1a79b55f1da93211b8a0a0",
        "98ecf95113fea999e94a928043e57b04cf58a45a1b66ae8bffc73d1bc8bb1d59",
      ],
      [
        "openshell-gateway-x86_64-unknown-linux-gnu.tar.gz",
        "b7760cb752a4363c2f21d32298dd0c683dc438f6edfd16c2e4242bc0baefbb7c",
        "e6cde8a54568aa1926ff6584ffd6984314c68dad64d2722509618a74094c622c",
      ],
      [
        "openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz",
        "559b8aaad3a8eeab45c511e7de531d9baa98a311282dcb0c2c5f38cc2d4ca355",
        "019301ec8618abbed8135e8d39dde7bea47e5e92813bbc17768550de34db59f8",
      ],
    ] as const;

    expect(source).toContain('readonly release_tag="v0.0.106"');
    expect(source).not.toMatch(/v0\.0\.(?:101|105|107)/u);
    for (const identity of identities.flat()) {
      expect(source.match(new RegExp(identity.replaceAll(".", "\\."), "gu"))).toHaveLength(1);
    }
    expect(source).toContain('printf \'%s  %s\\n\' "${archive_sha256[$index]}" "$archive" | sha256sum -c -');
    expect(source).toContain('printf \'%s  %s\\n\' "${binary_sha256[$index]}" "${extracted}/${member}" | sha256sum -c -');
    expect(source).toContain('printf \'%s  %s\\n\' "${binary_sha256[$index]}" "${target_dir}/${member}" | sha256sum -c -');
    execFileSync("bash", ["-n", installerPath]);
  });

  it("accepts the checked-in workflow and rejects protected trust-boundary mutations", () => {
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
    install.run = "bash scripts/install-openshell.sh";

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
        "openshell-gateway-auth-contract must set NEMOCLAW_CANDIDATE_VERSION=0.0.106",
        "openshell-gateway-auth-contract must set NEMOCLAW_OPENSHELL_PIN_VERSION=0.0.106",
        "openshell-gateway-auth-contract must not expose NVIDIA_API_KEY at job scope",
        "openshell-gateway-auth-contract action 'actions/checkout@v6' must pin a full SHA",
        "openshell-gateway-auth-contract checkout must disable persisted credentials",
        "openshell-gateway-auth-contract must use the reviewed prepare-e2e action",
        "openshell-gateway-auth-contract must run only the exact credential-free OpenShell 0.0.106 install",
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

  it("rejects a second product installer after the exact OpenShell 0.0.106 install", () => {
    const workflow = readOpenShellGatewayAuthContractWorkflow();
    const install = workflow.jobs["openshell-gateway-auth-contract"].steps!.find(
      (step) => step.name === "Install OpenShell CLI",
    )!;
    install.run += " && bash scripts/install-openshell.sh";

    expect(validateOpenShellGatewayAuthContractWorkflow(workflow)).toContain(
      "openshell-gateway-auth-contract must run only the exact credential-free OpenShell 0.0.106 install",
    );
  });

  it("rejects artifact safety commands that can mask scanner failures (#7101)", () => {
    const workflow = readOpenShellGatewayAuthContractWorkflow();
    const artifactSafety = workflow.jobs["openshell-gateway-auth-contract"].steps!.find(
      (step) => step.name === "Validate final OpenShell gateway auth contract artifacts",
    )!;
    artifactSafety.run = `${artifactSafety.run} || true`;

    expect(validateOpenShellGatewayAuthContractWorkflow(workflow)).toContain(
      "openshell-gateway-auth-contract step 'Validate final OpenShell gateway auth contract artifacts' must run exactly: node --experimental-strip-types --no-warnings tools/e2e/openshell-gateway-auth-artifact-safety.mts \"$E2E_ARTIFACT_DIR\"",
    );
  });
});
