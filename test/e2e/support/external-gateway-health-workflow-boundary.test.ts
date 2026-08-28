// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readExternalGatewayHealthWorkflow,
  validateExternalGatewayHealthWorkflow,
  validateExternalGatewayHealthWorkflowBoundary,
} from "../../../tools/e2e/external-gateway-health-workflow-boundary.mts";

describe("external gateway health workflow boundary", () => {
  it("accepts the checked-in trusted package and live-test contract", () => {
    expect(validateExternalGatewayHealthWorkflowBoundary()).toEqual([]);
  });

  it("rejects package credentials or untrusted candidate execution in the package job", () => {
    const workflow = readExternalGatewayHealthWorkflow();
    const job = workflow.jobs["package-openshell-sdk"];
    job.if = "${{ always() }}";
    job.permissions = { contents: "write", packages: "write" };
    const checkout = job.steps!.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    checkout.with!.ref = "${{ inputs.checkout_sha }}";
    const download = job.steps!.find(
      (step) => step.name === "Download and verify exact OpenShell SDK package",
    )!;
    download.env!.NODE_AUTH_TOKEN = "${{ secrets.PACKAGE_TOKEN }}";

    expect(validateExternalGatewayHealthWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "package-openshell-sdk must run only for the explicit external health selector",
        "package-openshell-sdk must retain its bounded package-read trust boundary",
        "package-openshell-sdk must execute only the trusted sparse package verifier checkout",
        "package-openshell-sdk must scope its package credential to the reviewed downloader",
      ]),
    );
  });

  it("rejects credential exposure and candidate or artifact substitution in the live job", () => {
    const workflow = readExternalGatewayHealthWorkflow();
    const job = workflow.jobs["external-gateway-health"];
    job.needs = "generate-matrix";
    job.env = { ...job.env, GITHUB_TOKEN: "${{ github.token }}" };
    const checkout = job.steps!.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    checkout.with!.ref = "main";
    const download = job.steps!.find(
      (step) => step.name === "Download reviewed OpenShell SDK archive",
    )!;
    download.with!.name = "unreviewed-sdk";
    const install = job.steps!.find(
      (step) => step.name === "Install reviewed OpenShell SDK archive without package credentials",
    )!;
    install.run = "npm install @nvidia/openshell-sdk@latest";
    const run = job.steps!.find((step) => step.name === "Run external gateway health live test")!;
    run.env = { NODE_AUTH_TOKEN: "${{ secrets.PACKAGE_TOKEN }}" };

    expect(validateExternalGatewayHealthWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "external-gateway-health must wait for the candidate CLI and reviewed SDK archive",
        "external-gateway-health must not expose GITHUB_TOKEN at job scope",
        "external-gateway-health must use the exact candidate checkout without persisted credentials",
        "external-gateway-health must download only this run's reviewed SDK archive",
        "external-gateway-health SDK install must retain: env -u NODE_AUTH_TOKEN -u GITHUB_TOKEN",
        'external-gateway-health SDK install must retain: npm install --no-save --package-lock=false --ignore-scripts "${archives[0]}"',
        "external-gateway-health must run only the credential-free external health test",
      ]),
    );
  });
});
