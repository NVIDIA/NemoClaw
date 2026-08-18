// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function completeBrief(plan: Record<string, string>): string {
  return [
    `# NemoClaw ${plan.nextTag} release brief`,
    "",
    `- Candidate: \`${plan.originMainCommit}\``,
    "",
    "## Canonical release entry",
    "",
    `## ${plan.nextTag}`,
    "",
    "- Release detail.",
    "",
    "## Pi documentation evidence",
    "",
    `- Pi candidate: \`${plan.originMainCommit}\``,
    "- Evidence: approved empty patch.",
    "",
    "## Base and managed image evidence",
    "",
    `- Base-image candidate: \`${plan.originMainCommit}\``,
    "- Evidence: successful publication aggregate.",
    "",
    "## Exact staging Brev Launchable evidence",
    "",
    `- Launchable candidate: \`${plan.originMainCommit}\``,
    "- Evidence: no exact staging Launchable check exists for the candidate.",
    "- Workspace cleanup: not applicable: no Launchable check ran",
    "",
    "## General E2E decision",
    "",
    "- Decision: proceed.",
    "",
    "Exceptions: None",
    "",
  ].join("\n");
}

export function failedLaunchableBrief(
  plan: Record<string, string>,
  cleanup: string,
  exception: string,
): string {
  return completeBrief(plan)
    .replace(
      "- Evidence: no exact staging Launchable check exists for the candidate.",
      "- Evidence: exact staging Launchable failed before cleanup confirmation.",
    )
    .replace("- Workspace cleanup: not applicable: no Launchable check ran", cleanup)
    .replace("- Decision: proceed.", "- Decision: proceed with recorded exception.")
    .replace("Exceptions: None", `Exceptions: ${exception}`);
}
