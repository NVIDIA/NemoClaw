// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readExternalGatewayHealthWorkflow,
  validateExternalGatewayHealthHelper,
  validateExternalGatewayHealthWorkflow,
  validateExternalGatewayHealthWorkflowBoundary,
} from "../../../tools/e2e/external-gateway-health-workflow-boundary.mts";
import { readRepoText } from "../../helpers/e2e-workflow-contract";

describe("external gateway health workflow boundary", () => {
  it("accepts the checked-in trusted package and live-test contract", () => {
    expect(validateExternalGatewayHealthWorkflowBoundary()).toEqual([]);
  });

  it("rejects a helper that bypasses the exact Runner or weakens its live boundary", () => {
    const source = readRepoText("test/e2e/live/external-gateway-health-helpers.ts")
      .replace('"--external-target"', '"--managed-target"')
      .replace("const address = externalHostAddress();", 'const address = "127.0.0.1";')
      .replace("maxAttempts: 10,", "maxAttempts: 100,")
      .replace(
        'runner: "dist/lib/blueprint-runner.js"',
        'runner: "test/e2e/live/external-gateway-health-helpers.ts"',
      )
      .replace("artifacts.addRedactionValues([stateDir]);", "")
      .concat('\nimport "@nvidia/openshell-sdk";\n');

    expect(validateExternalGatewayHealthHelper(source)).toEqual([
      "external gateway health helper must run exact Blueprint Runner external status",
      "external gateway health helper must bind the gateway certificate to a non-loopback address",
      "external gateway health helper must retain the bounded readiness retry",
      "external gateway health helper must record the exact Runner artifact identity",
      "external gateway health helper must redact its private fixture path",
      "external gateway health helper must not bypass the Runner with a direct SDK import",
    ]);
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
