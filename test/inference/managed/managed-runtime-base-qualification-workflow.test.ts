// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

describe("exact-base managed runtime qualification workflow", () => {
  it("runs and classifies both scenarios from the authenticated exact base", () => {
    const workflow = readWorkflow("managed-runtime-base-qualification.yaml");
    const authenticate = required(
      workflow.jobs?.["authenticate-candidate"],
      "missing candidate authentication job",
    );
    const candidate = required(
      workflow.jobs?.["candidate-activation"],
      "missing candidate activation job",
    );
    const base = required(
      workflow.jobs?.["exact-base-activation"],
      "missing exact-base activation job",
    );
    const classify = required(workflow.jobs?.classify, "missing managed runtime classifier");

    expect(workflow.on?.pull_request_target).toMatchObject({
      types: ["opened", "synchronize", "reopened"],
      paths: expect.arrayContaining([
        ".github/workflows/managed-images.yaml",
        ".github/workflows/managed-runtime-base-qualification.yaml",
        "test/e2e/live/managed-image-activation-e2e*.ts",
      ]),
    });
    expect(workflow.on?.workflow_dispatch?.inputs).toMatchObject({
      pr_number: expect.objectContaining({ required: true, type: "string" }),
      candidate_sha: expect.objectContaining({ required: true, type: "string" }),
      base_sha: expect.objectContaining({ required: true, type: "string" }),
      candidate_run_id: expect.objectContaining({ required: false, type: "string" }),
      candidate_run_attempt: expect.objectContaining({ required: false, type: "string" }),
    });
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(
      step(authenticate, "Check out exact base-controlled qualification controller").with,
    ).toMatchObject({ ref: "${{ github.workflow_sha }}", "persist-credentials": false });
    const select = step(authenticate, "Bind the current PR and exact candidate image catalog");
    expect(select.env).toMatchObject({
      PR_MANAGED_IMAGE_REQUIRE_CANDIDATE_CATALOG: "1",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(select.run).toContain('[[ "$WORKFLOW_SHA" == "$BASE_SHA" ]]');
    expect(select.run).toContain("pr-managed-image-publication.mts");

    expect(base.needs).toBe("authenticate-candidate");
    expect(candidate.needs).toBe("authenticate-candidate");
    expect(candidate.if).toBe("needs.authenticate-candidate.result == 'success'");
    expect(candidate.permissions).toEqual({ actions: "read", contents: "read", packages: "read" });
    expect(candidate.env?.NEMOCLAW_MANAGED_ACTIVATION_CATALOG).toBe(
      "${{ github.workspace }}/managed-runtime-candidate/catalog.json",
    );
    expect(step(candidate, "Check out exact base-controlled scenario controller").with?.ref).toBe(
      "${{ github.workflow_sha }}",
    );
    expect(step(candidate, "Check out exact candidate without credentials").with).toMatchObject({
      ref: "${{ needs.authenticate-candidate.outputs.candidate_sha }}",
      path: "candidate",
      "persist-credentials": false,
    });
    const candidateSdk = step(candidate, "Download reviewed OpenShell SDK without candidate code");
    expect(candidateSdk.env?.NODE_AUTH_TOKEN).toBe("${{ github.token }}");
    expect(JSON.stringify(candidateSdk)).not.toContain("working-directory: candidate");
    const candidateInstall =
      step(candidate, "Install trusted scenario and candidate dependencies without credentials")
        .run ?? "";
    expect(candidateInstall).toContain("env -u GITHUB_TOKEN -u NODE_AUTH_TOKEN");
    const candidateRun =
      step(candidate, "Run the base-controlled scenario with the exact candidate CLI").run ?? "";
    expect(candidateRun).toContain('test "$(git rev-parse --verify HEAD)" = "$BASE_SHA"');
    expect(candidateRun).toContain(
      'test "$(git -C candidate rev-parse --verify HEAD)" = "$CANDIDATE_SHA"',
    );
    expect(candidateRun).toContain("test/e2e/live/managed-image-activation-e2e.test.ts");
    expect(
      step(candidate, "Record the candidate activation receipt from trusted code").env,
    ).toMatchObject({
      GITHUB_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      MANAGED_RUNTIME_ROLE: "candidate",
    });

    expect(base["runs-on"]).toBe("ubuntu-24.04");
    expect(base.permissions).toEqual({ actions: "read", contents: "read", packages: "read" });
    expect(base.env?.NEMOCLAW_MANAGED_ACTIVATION_CATALOG).toBe(
      "${{ github.workspace }}/managed-runtime-base/catalog.json",
    );
    expect(step(base, "Check out exact comparison base").with).toMatchObject({
      ref: "${{ needs.authenticate-candidate.outputs.base_sha }}",
      path: "base",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(step(base, "Select the production managed-image cohort for the base").env).toMatchObject(
      {
        EXPECTED_SHA: "${{ needs.authenticate-candidate.outputs.base_sha }}",
        REQUIRE_MANAGED_IMAGE_PUBLICATION: "1",
        SELECT_NEAREST_SUCCESSFUL_PUBLICATION: "1",
      },
    );
    expect(
      step(base, "Validate the base cohort and materialize its runtime catalog").run,
    ).toContain("managed-image-cohort-contract.mts");
    const baseRun = step(base, "Run the identical exact-base managed runtime scenario").run ?? "";
    expect(baseRun).toContain('test "$(git rev-parse --verify HEAD)" = "$BASE_SHA"');
    expect(baseRun).toContain("test/e2e/live/managed-image-activation-e2e.test.ts");
    expect(step(base, "Record the base activation receipt").env).toMatchObject({
      MANAGED_RUNTIME_OUTCOME: "${{ steps.activation.outcome }}",
      MANAGED_RUNTIME_ROLE: "base",
      MANAGED_RUNTIME_SOURCE_SHA: "${{ needs.authenticate-candidate.outputs.base_sha }}",
    });

    expect(classify.needs).toEqual([
      "authenticate-candidate",
      "candidate-activation",
      "exact-base-activation",
    ]);
    expect(classify.if).toBe("always() && needs.authenticate-candidate.result == 'success'");
    expect(step(classify, "Compare authenticated scenario receipts")).toMatchObject({
      "continue-on-error": true,
      env: expect.objectContaining({
        BASE_JOB_CONCLUSION: "${{ needs.exact-base-activation.result }}",
        CANDIDATE_JOB_CONCLUSION: "${{ needs.candidate-activation.result }}",
        GITHUB_TOKEN: "${{ github.token }}",
        GITHUB_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      }),
    });
    expect(step(classify, "Preserve managed runtime comparison receipt").with?.name).toBe(
      "managed-runtime-comparison-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(step(classify, "Propagate the comparison classification").if).toBe(
      "always() && steps.classify.outcome != 'success'",
    );
  });
});
