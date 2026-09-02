// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const TRUSTED_GENERATED_HEAD_REF = "main";

export const GENERATED_HEAD_VALIDATIONS = [
  {
    workflow: "pr.yaml",
    titlePrefix: "Generated-head CI",
    requiredChecks: [
      { name: "changes", jobName: "changes" },
      { name: "checks", jobName: "checks" },
    ],
  },
  {
    workflow: "commit-lint.yaml",
    titlePrefix: "Generated-head title",
    requiredChecks: [{ name: "commit-lint", jobName: "commit-lint" }],
  },
  {
    workflow: "dco-check.yaml",
    titlePrefix: "Generated-head DCO",
    requiredChecks: [{ name: "dco-check", jobName: "dco-check" }],
  },
  {
    workflow: "installer-hash-check.yaml",
    titlePrefix: "Generated-head installer hash",
    requiredChecks: [{ name: "check-hash", jobName: "check-hash" }],
  },
  {
    workflow: "code-scanning.yaml",
    titlePrefix: "Generated-head CodeQL",
    requiredChecks: [],
  },
  {
    workflow: "pr-review-advisor.yaml",
    titlePrefix: "Generated-head Advisor",
    requiredChecks: [],
  },
] as const;

export function generatedHeadRunTitle(
  titlePrefix: string,
  attemptKey: string,
  commitSha: string,
): string {
  return `${titlePrefix} ${attemptKey} ${commitSha}`;
}
