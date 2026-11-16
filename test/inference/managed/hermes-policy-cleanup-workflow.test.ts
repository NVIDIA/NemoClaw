// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

it.each(
  [
    {
      job: "pr-build-and-entrypoint",
      barrier: "Log in to GHCR for exact same-repository PR digest",
    },
    { job: "build-and-validate", barrier: "Capture exact managed image publication evidence" },
  ].flatMap((lane) => [0, 23].map((exitCode) => ({ ...lane, exitCode }))),
)(
  "propagates Hermes policy cleanup status $exitCode before $job publication",
  ({ job, barrier, exitCode }) => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = required(workflow.jobs?.[job], `missing ${job}`);
    const qualification = step(builder, "Verify Hermes managed policy source cleanup");
    const result = spawnSync(
      "bash",
      ["-c", `npx() { return ${exitCode}; }\n${qualification.run}`],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    expect(result.status, result.stderr).toBe(exitCode);
    expect(qualification.if).toBe("matrix.agent == 'hermes'");
    expect(qualification).not.toHaveProperty("continue-on-error");
    expect(builder.steps!.indexOf(qualification)).toBeLessThan(
      builder.steps!.indexOf(step(builder, barrier)),
    );
  },
);
