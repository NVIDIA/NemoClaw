// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

describe("trusted candidate SDK audit workflow", () => {
  it.each([
    ["pr.yaml", "reviewed-npm-audit", "Checkout", "Audit reviewed production npm graphs"],
    [
      "managed-images.yaml",
      "pr-reviewed-npm-audit",
      "Checkout commit under review",
      "Audit exact PR production npm graphs",
    ],
  ])(
    "runs the %s PR audit from the base controller against the candidate",
    (workflow, jobId, candidateStep, auditStep) => {
      const job = required(readWorkflow(workflow!).jobs?.[jobId!], "missing PR audit");
      const controller = step(job, "Checkout trusted npm audit controller");
      const candidate = step(job, candidateStep!);
      expect(controller.with).toMatchObject({
        repository: "NVIDIA/NemoClaw",
        ref: "${{ github.event.pull_request.base.sha }}",
        path: ".trusted-npm-audit",
        "persist-credentials": false,
      });
      expect(candidate.with).toMatchObject({
        ref: "${{ github.event.pull_request.head.sha }}",
        path: "candidate",
        "persist-credentials": false,
      });
      expect(job.steps!.indexOf(controller)).toBeLessThan(job.steps!.indexOf(candidate));
      expect(job.permissions).toMatchObject({ contents: "read", "pull-requests": "read" });
      expect(step(job, auditStep!)).toMatchObject({
        uses: "./.trusted-npm-audit/.github/actions/ci-reviewed-npm-audit",
        with: {
          "target-root": "${{ github.workspace }}/candidate",
          "sdk-admission-token": "${{ github.token }}",
          "sdk-admission-pr-number": "${{ github.event.pull_request.number }}",
          "sdk-admission-candidate-sha": "${{ github.event.pull_request.head.sha }}",
          "sdk-admission-base-sha": "${{ github.event.pull_request.base.sha }}",
        },
      });
    },
  );
});
