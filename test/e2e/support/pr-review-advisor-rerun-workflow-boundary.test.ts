// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

const directories: string[] = [];
const contextError = "Unified advisor context artifact must survive failed-job and full reruns";
const specialistError = "Unified advisor specialist artifacts must be unique per rerun attempt";

function advisorWorkflow(options: {
  uploadName?: string;
  downloadName?: string;
  overwrite?: boolean;
  specialistName?: string;
}): string {
  const contextName = "pr-review-advisor-context-${{ github.run_id }}";
  const specialistName = "${{ matrix.advisor.artifact_name }}-${{ github.run_attempt }}";
  return [
    "permissions: read-all",
    "jobs:",
    "  discover-specialists:",
    "    steps:",
    "      - name: Upload GitHub review context",
    "        with:",
    `          name: ${options.uploadName ?? contextName}`,
    `          overwrite: ${options.overwrite ?? true}`,
    "  review-specialists:",
    "    env:",
    "      BASE_REF: ${{ github.event_name == 'pull_request_target' && 'target/base' || (github.event_name == 'workflow_dispatch' && inputs.target_repo != '' && inputs.target_pr != '' && 'target/base' || inputs.base_ref) }}",
    "      HEAD_REF: ${{ github.event_name == 'pull_request_target' && 'HEAD' || (github.event_name == 'workflow_dispatch' && inputs.target_repo != '' && inputs.target_pr != '' && 'HEAD' || inputs.head_ref) }}",
    "    steps:",
    "      - name: Download GitHub review context",
    "        with:",
    `          name: ${options.downloadName ?? contextName}`,
    "      - name: Upload specialist review",
    "        with:",
    `          name: ${options.specialistName ?? specialistName}`,
    "",
  ].join("\n");
}

function validateAdvisor(source: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-advisor-rerun-"));
  directories.push(directory);
  const advisorPath = join(directory, "advisor.yaml");
  writeFileSync(advisorPath, source);
  return validateE2eOperationsWorkflow(readE2eOperationsWorkflow(), advisorPath);
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("PR Review Advisor rerun artifact boundary", () => {
  it.each([
    { uploadName: "pr-review-advisor-context-${{ github.run_id }}-${{ github.run_attempt }}" },
    { downloadName: "pr-review-advisor-context-${{ github.run_id }}-${{ github.run_attempt }}" },
    { overwrite: false },
  ])("rejects context configuration that cannot survive reruns: %j", (options) => {
    expect(validateAdvisor(advisorWorkflow(options))).toContain(contextError);
  });

  it("rejects specialist artifacts shared across rerun attempts", () => {
    expect(
      validateAdvisor(advisorWorkflow({ specialistName: "${{ matrix.advisor.artifact_name }}" })),
    ).toContain(specialistError);
  });
});
