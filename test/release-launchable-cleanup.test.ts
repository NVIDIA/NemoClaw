// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { validateLaunchableCleanup } from "../scripts/release/launchable-cleanup.mts";

const candidate = "a".repeat(40);
const remediation =
  "remediated: workspace_removed=true; credentials_rotated_or_revoked=BREV_API_KEY,NEMOCLAW_IMAGE_DISPATCH_TOKEN,NVIDIA_INFERENCE_API_KEY; workspace_name=nclaw-e2e-1; workspace_id=qndmc83z0; run_id=100; job_id=200";

function checkRun(id: number, createdAt: string, conclusion: "failure" | "success", runId: number) {
  return {
    conclusion,
    created_at: createdAt,
    details_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${id}`,
    head_sha: candidate,
    id,
    name: "Exact staging Brev Launchable",
    status: "completed",
  };
}

it("rejects cleanup evidence from a different Launchable run", () => {
  const checkRuns = [{ check_runs: [checkRun(200, "2026-08-18T14:00:00Z", "failure", 100)] }];
  const cleanup = remediation.replace("run_id=100; job_id=200", "run_id=101; job_id=201");

  expect(() => validateLaunchableCleanup(checkRuns, candidate, cleanup)).toThrow(
    "does not match the candidate run and job",
  );
});

it("binds cleanup to the newest candidate Launchable check", () => {
  const checkRuns = [
    {
      check_runs: [
        checkRun(199, "2026-08-18T13:00:00Z", "success", 99),
        checkRun(200, "2026-08-18T14:00:00Z", "failure", 100),
      ],
    },
  ];

  expect(() => validateLaunchableCleanup(checkRuns, candidate, remediation)).not.toThrow();
});
