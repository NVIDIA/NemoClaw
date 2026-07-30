// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowAttemptEvidence } from "./runner-pressure-core.mts";

export const MAX_RUNNER_LOSS_JOB_ANNOTATIONS = 20;
export const MAX_RUNNER_LOSS_JOB_LOG_TAIL_BYTES = 64 * 1024;

const GITHUB_ACTIONS_APP_ID = 15368;
const GITHUB_HOSTED_RUNNER_NAME_PATTERN = /^GitHub Actions [1-9][0-9]*$/u;
const APPROVED_RUNNER_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;
const HOSTED_RUNNER_LOST_COMMUNICATION_MESSAGE =
  "The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.";
const GITHUB_INTERNAL_ERROR_MESSAGE =
  "GitHub Actions has encountered an internal error when running your job.";
const HOSTED_RUNNER_SHUTDOWN_MESSAGE =
  "The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.";
const HOSTED_RUNNER_OPERATION_CANCELLED_MESSAGE = "The operation was canceled.";
const HOSTED_RUNNER_EXIT_143_MESSAGE = "Process completed with exit code 143.";
const HOSTED_RUNNER_ORPHAN_CLEANUP_MESSAGE = "Cleaning up orphan processes";
const MAX_RUNNER_LOSS_ORPHAN_PROCESSES = 64;
const JOB_LOG_TIMESTAMPED_LINE_PATTERN =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z) (.*)$/u;
const JOB_LOG_ORPHAN_PROCESS_PATTERN =
  /^Terminate orphan process: pid \(([1-9][0-9]*)\) \(([A-Za-z0-9._+ -]{1,128})\)$/u;

type ApprovedInternalErrorConclusion = "failure" | "cancelled";

export type HostedRunnerLossPolicy = {
  githubInternalError?: {
    approvedRunnerLabels: readonly string[];
    approvedJobConclusions: readonly ApprovedInternalErrorConclusion[];
  };
};

export type WorkflowJobAnnotation = {
  path: string;
  blobHref: string;
  startLine: number;
  startColumn: number | null;
  endLine: number;
  endColumn: number | null;
  annotationLevel: string;
  title: string;
  message: string;
  rawDetails: string;
};

export type WorkflowJobCheckEvidence = {
  id: number;
  name: string;
  headSha: string;
  apiUrl: string;
  htmlUrl: string;
  detailsUrl: string;
  status: string;
  conclusion: string | null;
  appId: number;
  appSlug: string;
  annotationsCount: number;
  annotationsUrl: string;
};

export type WorkflowJobLogEvidence = {
  etag: string;
  totalBytes: number;
  tail: string;
};

export type WorkflowJob = {
  id: number;
  name: string;
  runId?: number;
  runAttempt?: number;
  headSha?: string;
  runUrl?: string;
  apiUrl?: string;
  htmlUrl?: string;
  checkRunUrl?: string;
  status?: string;
  conclusion: string | null;
  runnerId?: number | null;
  runnerName?: string | null;
  runnerGroupId?: number | null;
  runnerGroupName?: string | null;
  labels?: string[];
  annotations?: WorkflowJobAnnotation[];
  checkEvidence?: WorkflowJobCheckEvidence;
  logEvidence?: WorkflowJobLogEvidence;
  startedAt?: string | null;
  completedAt?: string | null;
  steps: Array<{
    name: string;
    status?: string;
    conclusion: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }>;
};

type HostedRunnerShutdownLogMarker = {
  shutdownTimestamp: string;
  terminalTimestamp: string;
  cleanupTimestamp: string;
  lastTimestamp: string;
  annotationMessage: string;
  interruptedStepConclusion: "cancelled" | "failure";
};

type NormalizedInternalErrorPolicy = {
  approvedRunnerLabels: ReadonlySet<string>;
  approvedJobConclusions: ReadonlySet<ApprovedInternalErrorConclusion>;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedInternalErrorPolicy(
  policy: HostedRunnerLossPolicy,
): NormalizedInternalErrorPolicy | null {
  if (!isObjectRecord(policy) || Object.keys(policy).some((key) => key !== "githubInternalError")) {
    throw new Error("hosted-runner-loss policy has an unsupported shape");
  }
  if (policy.githubInternalError === undefined) return null;
  const internal = policy.githubInternalError;
  if (
    !isObjectRecord(internal) ||
    Object.keys(internal).sort().join(",") !== "approvedJobConclusions,approvedRunnerLabels" ||
    !Array.isArray(internal.approvedRunnerLabels) ||
    internal.approvedRunnerLabels.length === 0 ||
    internal.approvedRunnerLabels.some(
      (label) =>
        typeof label !== "string" ||
        !APPROVED_RUNNER_LABEL_PATTERN.test(label) ||
        label === "self-hosted",
    ) ||
    new Set(internal.approvedRunnerLabels).size !== internal.approvedRunnerLabels.length ||
    !Array.isArray(internal.approvedJobConclusions) ||
    internal.approvedJobConclusions.length === 0 ||
    internal.approvedJobConclusions.some(
      (conclusion) => conclusion !== "failure" && conclusion !== "cancelled",
    ) ||
    new Set(internal.approvedJobConclusions).size !== internal.approvedJobConclusions.length
  ) {
    throw new Error("GitHub internal-error policy must use unique exact labels and conclusions");
  }
  return {
    approvedRunnerLabels: new Set(internal.approvedRunnerLabels),
    approvedJobConclusions: new Set(internal.approvedJobConclusions),
  };
}

function hasAssignedGitHubHostedRunner(job: WorkflowJob): boolean {
  return (
    Number.isSafeInteger(job.runnerId) &&
    (job.runnerId ?? 0) > 0 &&
    typeof job.runnerName === "string" &&
    GITHUB_HOSTED_RUNNER_NAME_PATTERN.test(job.runnerName) &&
    job.runnerGroupId === 0 &&
    job.runnerGroupName === "GitHub Actions" &&
    Array.isArray(job.labels) &&
    !job.labels.includes("self-hosted")
  );
}

function hasLegacyStrandedStepShape(job: WorkflowJob, requireNeighbors: boolean): boolean {
  const strandedIndexes = job.steps.flatMap((step, index) =>
    step.status === "in_progress" && step.conclusion === null ? [index] : [],
  );
  if (strandedIndexes.length !== 1) return false;
  const strandedIndex = strandedIndexes[0]!;
  if (requireNeighbors && (strandedIndex === 0 || strandedIndex === job.steps.length - 1)) {
    return false;
  }
  return (
    job.steps
      .slice(0, strandedIndex)
      .every(
        (step) =>
          step.status === "completed" && ["success", "skipped"].includes(step.conclusion ?? ""),
      ) &&
    job.steps
      .slice(strandedIndex + 1)
      .every((step) => step.status === "pending" && step.conclusion === null)
  );
}

function hasTrustedHostedRunnerLossStepShapeForConclusion(
  job: WorkflowJob,
  interruptedStepConclusion: "cancelled" | "failure",
  options: { allowLegacyStrandedStep: boolean },
): boolean {
  if (
    job.status !== "completed" ||
    job.conclusion !== "failure" ||
    !hasAssignedGitHubHostedRunner(job) ||
    !job.labels?.includes("ubuntu-latest")
  ) {
    return false;
  }
  if (
    options.allowLegacyStrandedStep &&
    interruptedStepConclusion === "cancelled" &&
    hasLegacyStrandedStepShape(job, false)
  ) {
    return true;
  }

  const interruptedStepIndexes = job.steps.flatMap((step, index) =>
    step.status === "completed" && step.conclusion === interruptedStepConclusion ? [index] : [],
  );
  if (interruptedStepIndexes.length !== 1) return false;
  const interruptedIndex = interruptedStepIndexes[0]!;
  if (job.steps[interruptedIndex]?.name === "Complete job") return false;
  const beforeInterruption = job.steps.slice(0, interruptedIndex);
  const afterInterruption = job.steps.slice(interruptedIndex + 1);
  const syntheticCompletion = afterInterruption.at(-1);
  const skippedCleanup = afterInterruption.slice(0, -1);
  return (
    beforeInterruption.every(
      (step) =>
        step.status === "completed" && ["success", "skipped"].includes(step.conclusion ?? ""),
    ) &&
    skippedCleanup.length > 0 &&
    skippedCleanup.every(
      (step) =>
        step.name !== "Complete job" &&
        step.status === "completed" &&
        step.conclusion === "skipped",
    ) &&
    syntheticCompletion?.name === "Complete job" &&
    syntheticCompletion.status === "completed" &&
    syntheticCompletion.conclusion === "success"
  );
}

function hasTrustedHostedRunnerLossStepShape(job: WorkflowJob): boolean {
  return hasTrustedHostedRunnerLossStepShapeForConclusion(job, "cancelled", {
    allowLegacyStrandedStep: true,
  });
}

function hasGitHubInternalErrorInspectionShape(
  job: WorkflowJob,
  policy: NormalizedInternalErrorPolicy | null,
): boolean {
  return (
    policy !== null &&
    job.status === "completed" &&
    (job.conclusion === "failure" || job.conclusion === "cancelled") &&
    policy.approvedJobConclusions.has(job.conclusion) &&
    hasAssignedGitHubHostedRunner(job) &&
    job.labels?.length === 1 &&
    policy.approvedRunnerLabels.has(job.labels[0]!) &&
    hasLegacyStrandedStepShape(job, true)
  );
}

function isHostedRunnerLossInspectionCandidateWithPolicy(
  job: WorkflowJob,
  internalPolicy: NormalizedInternalErrorPolicy | null,
): boolean {
  return (
    hasTrustedHostedRunnerLossStepShape(job) ||
    hasTrustedHostedRunnerLossStepShapeForConclusion(job, "failure", {
      allowLegacyStrandedStep: false,
    }) ||
    hasGitHubInternalErrorInspectionShape(job, internalPolicy)
  );
}

export function isHostedRunnerLossInspectionCandidate(
  job: WorkflowJob,
  policy: HostedRunnerLossPolicy = {},
): boolean {
  return isHostedRunnerLossInspectionCandidateWithPolicy(
    job,
    normalizedInternalErrorPolicy(policy),
  );
}

function trustedWorkflowJobAnnotations(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
): WorkflowJobAnnotation[] | null {
  if (job.headSha !== workflowSha || !Array.isArray(job.annotations)) return null;
  const blobPrefix = `https://github.com/${repository}/blob/${workflowSha}/`;
  if (
    job.annotations.some((annotation) => annotation.blobHref !== `${blobPrefix}${annotation.path}`)
  ) {
    return null;
  }
  return job.annotations;
}

function hasExactFailureAnnotation(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
  message: string,
  exactFirstLine: boolean,
): boolean {
  const annotations = trustedWorkflowJobAnnotations(job, repository, workflowSha);
  if (!annotations) return false;
  const failures = annotations.filter((annotation) => annotation.annotationLevel === "failure");
  const failure = failures[0];
  return (
    failures.length === 1 &&
    failure?.path === ".github" &&
    (exactFirstLine
      ? failure.startLine === 1 && failure.endLine === 1
      : failure.startLine === failure.endLine) &&
    failure.startColumn === null &&
    failure.endColumn === null &&
    failure.title === "" &&
    failure.rawDetails === "" &&
    failure.message === message
  );
}

function hasTrustedHostedRunnerLossAnnotation(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
): boolean {
  return hasExactFailureAnnotation(
    job,
    repository,
    workflowSha,
    HOSTED_RUNNER_LOST_COMMUNICATION_MESSAGE,
    true,
  );
}

function hasCompatibleHostedRunnerShutdownAnnotations(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
  expectedMessage: string,
): boolean {
  return hasExactFailureAnnotation(job, repository, workflowSha, expectedMessage, false);
}

function hasExactGitHubCheckEvidence(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
): boolean {
  const check = job.checkEvidence;
  if (
    !check ||
    !Number.isSafeInteger(job.runId) ||
    (job.runId ?? 0) < 1 ||
    !Number.isSafeInteger(job.runAttempt) ||
    (job.runAttempt ?? 0) < 1
  ) {
    return false;
  }
  const apiRepository = `https://api.github.com/repos/${repository}`;
  const webRepository = `https://github.com/${repository}`;
  const expectedRunUrl = `${apiRepository}/actions/runs/${job.runId}`;
  const expectedJobUrl = `${apiRepository}/actions/jobs/${job.id}`;
  const expectedCheckRunUrl = `${apiRepository}/check-runs/${job.id}`;
  const expectedHtmlUrl = `${webRepository}/actions/runs/${job.runId}/job/${job.id}`;
  return (
    job.headSha === workflowSha &&
    job.runUrl === expectedRunUrl &&
    job.apiUrl === expectedJobUrl &&
    job.htmlUrl === expectedHtmlUrl &&
    job.checkRunUrl === expectedCheckRunUrl &&
    check.id === job.id &&
    check.name === job.name &&
    check.headSha === workflowSha &&
    check.apiUrl === expectedCheckRunUrl &&
    check.htmlUrl === expectedHtmlUrl &&
    check.detailsUrl === expectedHtmlUrl &&
    check.status === "completed" &&
    check.conclusion === job.conclusion &&
    check.appId === GITHUB_ACTIONS_APP_ID &&
    check.appSlug === "github-actions" &&
    Number.isSafeInteger(check.annotationsCount) &&
    check.annotationsCount >= 0 &&
    check.annotationsCount <= MAX_RUNNER_LOSS_JOB_ANNOTATIONS &&
    check.annotationsCount === job.annotations?.length &&
    check.annotationsUrl === `${expectedCheckRunUrl}/annotations`
  );
}

function jobLogTimestampSecond(timestamp: string): string | null {
  const second = `${timestamp.slice(0, 19)}Z`;
  const milliseconds = Date.parse(second);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 19) === timestamp.slice(0, 19)
    ? second
    : null;
}

function parseHostedRunnerShutdownLogTail(logTail: string): HostedRunnerShutdownLogMarker | null {
  if (!logTail.endsWith("\n") || logTail.endsWith("\n\n")) return null;
  const lines = logTail.slice(0, -1).split("\n");
  const shutdownMessage = `##[error]${HOSTED_RUNNER_SHUTDOWN_MESSAGE}`;
  const shutdownIndex = lines
    .map((line) => JOB_LOG_TIMESTAMPED_LINE_PATTERN.exec(line)?.[2] ?? "")
    .lastIndexOf(shutdownMessage);
  if (shutdownIndex < 0) return null;
  const terminalLines = lines.slice(shutdownIndex);
  if (terminalLines.length < 3 || terminalLines.length > 3 + MAX_RUNNER_LOSS_ORPHAN_PROCESSES) {
    return null;
  }
  if (terminalLines.some((line) => line.includes("\r"))) return null;
  const parsed = terminalLines.map((line) => JOB_LOG_TIMESTAMPED_LINE_PATTERN.exec(line));
  if (parsed.some((line) => line === null)) return null;
  const timestamps = parsed.map((line) => line?.[1] ?? "");
  const timestampSeconds = timestamps.map(jobLogTimestampSecond);
  const messages = parsed.map((line) => line?.[2] ?? "");
  const terminalMessage = messages[1];
  const interruptedStepConclusion =
    terminalMessage === `##[error]${HOSTED_RUNNER_OPERATION_CANCELLED_MESSAGE}`
      ? "cancelled"
      : terminalMessage === `##[error]${HOSTED_RUNNER_EXIT_143_MESSAGE}`
        ? "failure"
        : null;
  if (
    timestampSeconds.some((timestamp) => timestamp === null) ||
    messages[0] !== shutdownMessage ||
    interruptedStepConclusion === null ||
    messages[2] !== HOSTED_RUNNER_ORPHAN_CLEANUP_MESSAGE ||
    timestamps[0]! >= timestamps[1]! ||
    timestamps.slice(1).some((timestamp, index) => timestamp < timestamps[index]!)
  ) {
    return null;
  }
  const orphanProcesses = messages
    .slice(3)
    .map((message) => JOB_LOG_ORPHAN_PROCESS_PATTERN.exec(message));
  const orphanProcessIds = orphanProcesses.map((process) => process?.[1] ?? "");
  if (
    orphanProcesses.some((process) => process === null) ||
    new Set(orphanProcessIds).size !== orphanProcessIds.length
  ) {
    return null;
  }
  return {
    shutdownTimestamp: timestamps[0]!,
    terminalTimestamp: timestamps[1]!,
    cleanupTimestamp: timestamps[2]!,
    lastTimestamp: timestamps.at(-1)!,
    annotationMessage: terminalMessage!.slice("##[error]".length),
    interruptedStepConclusion,
  };
}

function isBoundedWorkflowJobLogEvidence(evidence: WorkflowJobLogEvidence): boolean {
  const tailBytes = Buffer.byteLength(evidence.tail, "utf8");
  return (
    /^"[^"\r\n]{1,128}"$/u.test(evidence.etag) &&
    Number.isSafeInteger(evidence.totalBytes) &&
    evidence.totalBytes > 0 &&
    tailBytes > 0 &&
    tailBytes <= evidence.totalBytes &&
    tailBytes <= MAX_RUNNER_LOSS_JOB_LOG_TAIL_BYTES
  );
}

function hasTrustedHostedRunnerShutdownLog(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
): boolean {
  const evidence = job.logEvidence;
  if (!evidence || !isBoundedWorkflowJobLogEvidence(evidence)) return false;
  const marker = parseHostedRunnerShutdownLogTail(evidence.tail);
  if (
    !marker ||
    !hasCompatibleHostedRunnerShutdownAnnotations(
      job,
      repository,
      workflowSha,
      marker.annotationMessage,
    ) ||
    !hasTrustedHostedRunnerLossStepShapeForConclusion(job, marker.interruptedStepConclusion, {
      allowLegacyStrandedStep: false,
    })
  ) {
    return false;
  }
  const interruptedSteps = job.steps.filter(
    (step) => step.status === "completed" && step.conclusion === marker.interruptedStepConclusion,
  );
  const interruptedStep = interruptedSteps[0];
  if (
    interruptedSteps.length !== 1 ||
    !job.startedAt ||
    !job.completedAt ||
    !interruptedStep?.startedAt ||
    !interruptedStep.completedAt
  ) {
    return false;
  }
  const shutdownSecond = jobLogTimestampSecond(marker.shutdownTimestamp);
  const terminalSecond = jobLogTimestampSecond(marker.terminalTimestamp);
  const cleanupSecond = jobLogTimestampSecond(marker.cleanupTimestamp);
  const lastSecond = jobLogTimestampSecond(marker.lastTimestamp);
  return (
    shutdownSecond !== null &&
    terminalSecond !== null &&
    cleanupSecond !== null &&
    lastSecond !== null &&
    job.startedAt <= interruptedStep.startedAt &&
    interruptedStep.startedAt <= shutdownSecond &&
    terminalSecond === interruptedStep.completedAt &&
    interruptedStep.completedAt <= cleanupSecond &&
    cleanupSecond <= lastSecond &&
    lastSecond <= job.completedAt
  );
}

function hasGitHubInternalErrorMarker(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
  policy: NormalizedInternalErrorPolicy | null,
): boolean {
  return (
    hasGitHubInternalErrorInspectionShape(job, policy) &&
    hasExactGitHubCheckEvidence(job, repository, workflowSha) &&
    hasExactFailureAnnotation(job, repository, workflowSha, GITHUB_INTERNAL_ERROR_MESSAGE, true)
  );
}

function hasTrustedHostedRunnerLossMarker(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
  internalPolicy: NormalizedInternalErrorPolicy | null,
): boolean {
  return (
    (hasTrustedHostedRunnerLossStepShape(job) &&
      hasTrustedHostedRunnerLossAnnotation(job, repository, workflowSha)) ||
    hasTrustedHostedRunnerShutdownLog(job, repository, workflowSha) ||
    hasGitHubInternalErrorMarker(job, repository, workflowSha, internalPolicy)
  );
}

export function needsHostedRunnerShutdownLog(
  job: WorkflowJob,
  repository: string,
  workflowSha: string,
  policy: HostedRunnerLossPolicy = {},
): boolean {
  const internalPolicy = normalizedInternalErrorPolicy(policy);
  if (!isHostedRunnerLossInspectionCandidateWithPolicy(job, internalPolicy)) return false;
  if (hasGitHubInternalErrorInspectionShape(job, internalPolicy)) return false;
  return (
    !hasTrustedHostedRunnerLossAnnotation(job, repository, workflowSha) &&
    (hasCompatibleHostedRunnerShutdownAnnotations(
      job,
      repository,
      workflowSha,
      HOSTED_RUNNER_OPERATION_CANCELLED_MESSAGE,
    ) ||
      hasCompatibleHostedRunnerShutdownAnnotations(
        job,
        repository,
        workflowSha,
        HOSTED_RUNNER_EXIT_143_MESSAGE,
      ))
  );
}

export function verifiedRunnerLossEvidence(options: {
  repository: string;
  workflowSha: string;
  workflowConclusion: string | null;
  jobs: readonly WorkflowJob[];
  jobDetailsAvailable: boolean;
  jobDetailsComplete: boolean;
  policy?: HostedRunnerLossPolicy;
}): WorkflowAttemptEvidence | null {
  const internalPolicy = normalizedInternalErrorPolicy(options.policy ?? {});
  if (
    !options.jobDetailsAvailable ||
    !options.jobDetailsComplete ||
    options.jobs.length === 0 ||
    options.workflowConclusion !== "failure"
  ) {
    return null;
  }
  const hasTrustedMarker = (job: WorkflowJob): boolean =>
    hasTrustedHostedRunnerLossMarker(job, options.repository, options.workflowSha, internalPolicy);
  const runnerLostMarkerCount = options.jobs.filter(hasTrustedMarker).length;
  const otherNonPassingEvidencePresent = options.jobs.some((job) => !hasTrustedMarker(job));
  return {
    terminalClassificationPresent: otherNonPassingEvidencePresent,
    jobConclusion: "failure",
    runnerLostMarkerCount,
  };
}
