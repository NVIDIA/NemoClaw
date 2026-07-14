// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const DEEPAGENTS_FRESH_REONBOARD_CHECK =
  "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh";
export const DEEPAGENTS_OBSERVABILITY_CHECK =
  "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh";
export const DEEPAGENTS_THREAD_AUTO_APPROVAL_CHECK =
  "test/e2e/e2e-cloud-experimental/checks/12-deepagents-code-thread-auto-approval.sh";

export const DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS = [
  "test/e2e/e2e-cloud-experimental/checks/03-deepagents-code-nemotron-ultra-profile.sh",
  DEEPAGENTS_FRESH_REONBOARD_CHECK,
  "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
  "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
  "test/e2e/e2e-cloud-experimental/checks/07-deepagents-code-headless-inference.sh",
  "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
  "test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh",
  "test/e2e/e2e-cloud-experimental/checks/10-deepagents-code-tui-startup.sh",
  DEEPAGENTS_OBSERVABILITY_CHECK,
  DEEPAGENTS_THREAD_AUTO_APPROVAL_CHECK,
] as const;

export function cloudExperimentalChecksForOnboarding(
  onboarding: string | undefined,
): readonly string[] {
  return onboarding === "cloud-langchain-deepagents-code"
    ? DEEPAGENTS_CLOUD_EXPERIMENTAL_CHECKS
    : [];
}
