// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

describe("exact-base managed runtime qualification trust boundary", () => {
  it("keeps automatic exact-base qualification and receipt authority on trusted workflow code", () => {
    const workflow = readWorkflow("managed-runtime-base-qualification.yaml");
    const source = required(
      workflow.jobs?.["authenticate-source"],
      "missing managed-image source authentication",
    );
    const candidate = required(
      workflow.jobs?.["trusted-candidate-activation"],
      "missing trusted candidate activation",
    );
    const evidence = required(
      workflow.jobs?.["authenticate-candidate-evidence"],
      "missing fresh-runner candidate evidence authentication",
    );
    const classify = required(workflow.jobs?.classify, "missing managed runtime classifier");
    const prWorkflow = readWorkflow("managed-images.yaml");

    expect(workflow.on?.workflow_run).toEqual({
      workflows: ["Images / Build, Test, and Publish Managed Images"],
      types: ["completed"],
    });
    expect(workflow.permissions).toMatchObject({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(step(source, "Bind the current PR and managed-image attempt").run).toContain(
      "managed-runtime-comparison.mts select-source",
    );
    expect(step(source, "Mark exact-base qualification pending on the candidate").run).toContain(
      "publish-status pending",
    );

    expect(step(candidate, "Check out trusted qualification controller").with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: "trusted",
      "persist-credentials": false,
    });
    expect(step(candidate, "Check out candidate only as the product input").with).toMatchObject({
      ref: "${{ needs.authenticate-source.outputs.candidate_sha }}",
      path: "candidate",
      "persist-credentials": false,
    });
    expect(
      step(candidate, "Download exact candidate image contracts from the authenticated attempt")
        .with,
    ).toMatchObject({
      "run-id": "${{ needs.authenticate-source.outputs.source_run_id }}",
      pattern:
        "managed-pr-contract-${{ needs.authenticate-source.outputs.source_run_id }}-${{ needs.authenticate-source.outputs.source_run_attempt }}-*",
    });
    expect(step(candidate, "Run the trusted scenario against candidate inputs")).toMatchObject({
      "working-directory": "trusted",
    });
    expect(candidate.env?.NEMOCLAW_CLI_BIN).toBe(
      "${{ github.workspace }}/candidate/bin/nemoclaw.js",
    );
    expect(JSON.stringify(candidate)).not.toContain("managed-runtime-comparison.mts record");
    expect(
      step(evidence, "Record trusted candidate activation receipt on a fresh runner").run,
    ).toContain("tools/e2e/managed-runtime-comparison.mts");
    expect(
      step(evidence, "Record trusted candidate activation receipt on a fresh runner").env,
    ).toMatchObject({
      MANAGED_RUNTIME_OUTCOME: "${{ needs.trusted-candidate-activation.result }}",
    });
    expect(JSON.stringify(prWorkflow)).not.toContain("managed-runtime-activation-receipt");
    expect(step(classify, "Publish qualification result on the candidate commit").run).toContain(
      "publish-status result",
    );
  });
});
