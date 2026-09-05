// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

it("mints a fresh immutable publication cohort when every job is rerun", () => {
  const workflow = readWorkflow("managed-images.yaml");
  const identity = required(
    workflow.jobs?.["publication-identity"],
    "managed-image workflow is missing its publication identity",
  );
  const recordIdentity = step(identity, "Record publication identity");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-publication-identity-"));
  const output = path.join(temporaryRoot, "github-output");
  try {
    const result = spawnSync("bash", ["-c", recordIdentity.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "7744",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe("cohort=ghrun-7744-2\n");
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
