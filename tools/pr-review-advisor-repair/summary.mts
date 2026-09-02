// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { AttemptReceipt } from "./audit.mts";
import {
  RepairContractError,
  type ProposalReceipt,
  type SelectionBundle,
  type ValidationReceipt,
} from "./contract.mts";
import type { PublicationReceipt } from "./publish.mts";

const MAX_JOB_SUMMARY_BYTES = 1024 * 1024;
const MAX_RENDERED_SUMMARY_BYTES = 8 * 1024;

type AttemptSummaryReceipt = Pick<
  AttemptReceipt,
  "workflow" | "dispatch" | "emergencySwitch" | "outcome" | "reason"
>;

type PublicationSummaryReceipt = Pick<
  PublicationReceipt,
  "attemptKey" | "sourceHeadSha" | "candidateTreeSha" | "commitSha" | "dispatchedWorkflows"
>;

function safeValue(value: string | number | boolean | null): string {
  const rendered = value === null ? "none" : String(value);
  if (
    rendered.length === 0 ||
    Buffer.byteLength(rendered, "utf8") > 512 ||
    !/^[A-Za-z0-9 .,:/_-]+$/u.test(rendered)
  ) {
    throw new RepairContractError("repair job summary contains an unsafe value");
  }
  return rendered;
}

function render(
  stage: string,
  rows: Array<readonly [string, string | number | boolean | null]>,
): string {
  const title = safeValue(stage);
  const body = rows
    .map(([label, value]) => `| ${safeValue(label)} | \`${safeValue(value)}\` |`)
    .join("\n");
  const summary = `### PR Review Advisor repair — ${title}\n\n| Field | Value |\n| --- | --- |\n${body}\n`;
  if (Buffer.byteLength(summary, "utf8") > MAX_RENDERED_SUMMARY_BYTES) {
    throw new RepairContractError("repair job summary exceeds its size limit");
  }
  return summary;
}

export function appendRepairJobSummary(file: string | undefined, summary: string): void {
  if (!file) return;
  const descriptor = fs.openSync(
    file,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size + Buffer.byteLength(summary, "utf8") > MAX_JOB_SUMMARY_BYTES
    ) {
      throw new RepairContractError("GitHub job summary must be a bounded regular file");
    }
    fs.writeFileSync(descriptor, summary);
  } finally {
    fs.closeSync(descriptor);
  }
}

function report(file: string | undefined, summary: () => string): void {
  try {
    appendRepairJobSummary(file, summary());
  } catch {
    console.warn("PR Review Advisor repair job summary could not be written");
  }
}

export function appendAttemptJobSummary(
  file: string | undefined,
  receipt: AttemptSummaryReceipt,
): void {
  report(file, () =>
    render("attempt gate", [
      ["Outcome", receipt.outcome],
      ["Reason", receipt.reason],
      ["PR", receipt.dispatch.prNumber],
      ["Advisor run", receipt.dispatch.advisorRunId],
      ["Workflow run", receipt.workflow.runId],
      ["Workflow attempt", receipt.workflow.runAttempt],
      ["Workflow SHA", receipt.workflow.workflowSha],
      ["Finding IDs digest", receipt.dispatch.findingIdsSha256],
      ["Emergency switch", receipt.emergencySwitch.enabled],
      ["Repository egress authorized", receipt.dispatch.repositoryEgressAuthorized],
    ]),
  );
}

export function appendSelectionJobSummary(
  file: string | undefined,
  selection: SelectionBundle,
): void {
  report(file, () =>
    render("trusted selection", [
      ["Outcome", selection.outcome],
      ["Identity", selection.identityStatus],
      ["Attempt", selection.attemptKey],
      ["Source head", selection.input.sourceHeadSha],
      ["Base", selection.input.baseSha],
      ["Advisor run", selection.input.advisor.runId],
      ["Advisor attempt", selection.input.advisor.runAttempt],
      ["Bound artifacts", selection.input.advisor.artifactIds.length],
      ["Selected findings", selection.selectedFindingIds.length],
      ["Selected paths", selection.selectedPaths.length],
    ]),
  );
}

export function appendClaimJobSummary(
  file: string | undefined,
  attemptKey: string,
  checkId: number,
): void {
  report(file, () =>
    render("one-shot claim", [
      ["Outcome", "claimed"],
      ["Attempt", attemptKey],
      ["Check ID", checkId],
    ]),
  );
}

export function appendProposalJobSummary(
  file: string | undefined,
  proposal: ProposalReceipt,
): void {
  report(file, () =>
    render("offline proposal", [
      ["Outcome", proposal.outcome],
      ["Attempt", proposal.attemptKey],
      ["Source head", proposal.sourceHeadSha],
      ["Findings", proposal.findingIds.length],
      ["Unresolved findings", proposal.unresolvedFindingIds.length],
      ["Changed paths", proposal.changedPaths.length],
    ]),
  );
}

export function appendValidationJobSummary(
  file: string | undefined,
  receipt: ValidationReceipt,
): void {
  report(file, () =>
    render("trusted validation", [
      ["Outcome", receipt.outcome],
      ["Attempt", receipt.attemptKey],
      ["PR", receipt.prNumber],
      ["Source head", receipt.sourceHeadSha],
      ["Base", receipt.baseSha],
      ["Patch digest", receipt.patchSha256],
      ["Candidate tree", receipt.candidateTreeSha],
      ["Changed paths", receipt.changedPaths.length],
      ["Validation commands", receipt.validation.commands.length],
    ]),
  );
}

export function appendPublicationJobSummary(
  file: string | undefined,
  receipt: PublicationSummaryReceipt,
): void {
  report(file, () =>
    render("publication", [
      ["Outcome", "published"],
      ["Attempt", receipt.attemptKey],
      ["Source head", receipt.sourceHeadSha],
      ["Candidate tree", receipt.candidateTreeSha],
      ["Verified commit", receipt.commitSha],
      ["Dispatched workflows", receipt.dispatchedWorkflows.length],
    ]),
  );
}

export function appendGeneratedHeadJobSummary(
  file: string | undefined,
  attemptKey: string,
  commitSha: string,
): void {
  report(file, () =>
    render("generated-head gates", [
      ["Outcome", "passed"],
      ["Attempt", attemptKey],
      ["Exact commit", commitSha],
    ]),
  );
}
