// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export const confirmationFor = (plan: Record<string, string>): string =>
  `CONFIRM RELEASE ${plan.nextTag} ${plan.originMainCommit}`;

export function writeLaunchableCheckRuns(
  directory: string,
  candidate: string,
  conclusion: "failure" | "missing" | "success",
): string {
  const output = path.join(directory, `launchable-check-runs-${conclusion}.json`);
  const checkRuns =
    conclusion === "missing"
      ? []
      : [
          {
            conclusion,
            created_at: "2026-08-18T14:00:00Z",
            details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/100/job/200",
            head_sha: candidate,
            id: 200,
            name: "Exact staging Brev Launchable",
            status: "completed",
          },
        ];
  fs.writeFileSync(
    output,
    JSON.stringify([{ check_runs: checkRuns, total_count: checkRuns.length }]),
  );
  return output;
}

export function launchableCheckRunsEnv(
  directory: string,
  candidate: string,
  conclusion: "failure" | "missing" | "success",
): NodeJS.ProcessEnv {
  return {
    NEMOCLAW_RELEASE_TEST_CHECK_RUNS_FILE: writeLaunchableCheckRuns(
      directory,
      candidate,
      conclusion,
    ),
  };
}
