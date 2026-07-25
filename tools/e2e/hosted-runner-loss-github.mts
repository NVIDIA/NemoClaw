// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { githubApi } from "../advisors/github.mts";
import {
  type HostedRunnerLossPolicy,
  isHostedRunnerLossInspectionCandidate,
  MAX_RUNNER_LOSS_JOB_ANNOTATIONS,
  MAX_RUNNER_LOSS_JOB_LOG_TAIL_BYTES,
  needsHostedRunnerShutdownLog,
  type WorkflowJob,
  type WorkflowJobAnnotation,
  type WorkflowJobCheckEvidence,
  type WorkflowJobLogEvidence,
} from "./hosted-runner-loss.mts";

const GITHUB_ACTIONS_APP_ID = 15368;
const USER_AGENT = "nemoclaw-pr-e2e-gate";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_WORKFLOW_JOB_PAGES = 10;
const MAX_JOB_ANNOTATION_PAGES = 1;
const MAX_JOB_ANNOTATION_IDENTITY_BYTES = 8 * 1024;
const MAX_JOB_ANNOTATION_TEXT_BYTES = 16 * 1024;
const MAX_RUNNER_LOSS_JOB_ANNOTATION_BYTES = 64 * 1024;
const MAX_RUNNER_LOSS_JOB_INSPECTIONS = 20;
const RUNNER_LOSS_JOB_LOG_TIMEOUT_MS = 30_000;
const JOB_LOG_DOWNLOAD_HOST_PATTERN = /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/u;
const GITHUB_TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;

type WorkflowJobsPage = { totalCount: number; jobs: WorkflowJob[] };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isOptionalGitHubTimestamp(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && GITHUB_TIMESTAMP_PATTERN.test(value))
  );
}

function validateWorkflowJob(value: unknown): WorkflowJob {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 1 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    (value.run_id !== undefined &&
      (!Number.isSafeInteger(value.run_id) || (value.run_id as number) < 1)) ||
    (value.run_attempt !== undefined &&
      (!Number.isSafeInteger(value.run_attempt) || (value.run_attempt as number) < 1)) ||
    (value.head_sha !== undefined &&
      (typeof value.head_sha !== "string" || !SHA_PATTERN.test(value.head_sha))) ||
    (value.run_url !== undefined && typeof value.run_url !== "string") ||
    (value.url !== undefined && typeof value.url !== "string") ||
    (value.html_url !== undefined && typeof value.html_url !== "string") ||
    (value.check_run_url !== undefined && typeof value.check_run_url !== "string") ||
    (value.status !== undefined && typeof value.status !== "string") ||
    (value.conclusion !== null && typeof value.conclusion !== "string") ||
    !isOptionalGitHubTimestamp(value.started_at) ||
    !isOptionalGitHubTimestamp(value.completed_at) ||
    (value.runner_id !== undefined &&
      value.runner_id !== null &&
      (!Number.isSafeInteger(value.runner_id) || (value.runner_id as number) < 1)) ||
    (value.runner_name !== undefined &&
      value.runner_name !== null &&
      typeof value.runner_name !== "string") ||
    (value.runner_group_id !== undefined &&
      value.runner_group_id !== null &&
      (!Number.isSafeInteger(value.runner_group_id) || (value.runner_group_id as number) < 0)) ||
    (value.runner_group_name !== undefined &&
      value.runner_group_name !== null &&
      typeof value.runner_group_name !== "string") ||
    (value.labels !== undefined &&
      (!Array.isArray(value.labels) || value.labels.some((label) => typeof label !== "string"))) ||
    (value.steps !== undefined && !Array.isArray(value.steps))
  ) {
    throw new Error("GitHub returned an invalid workflow job");
  }
  const steps = (value.steps ?? []).map((step) => {
    if (
      !isObjectRecord(step) ||
      typeof step.name !== "string" ||
      step.name.length === 0 ||
      (step.status !== undefined && typeof step.status !== "string") ||
      (step.conclusion !== null && typeof step.conclusion !== "string") ||
      !isOptionalGitHubTimestamp(step.started_at) ||
      !isOptionalGitHubTimestamp(step.completed_at)
    ) {
      throw new Error("GitHub returned an invalid workflow job step");
    }
    return {
      name: step.name,
      ...(step.status === undefined ? {} : { status: step.status }),
      conclusion: step.conclusion,
      ...(step.started_at === undefined ? {} : { startedAt: step.started_at as string | null }),
      ...(step.completed_at === undefined
        ? {}
        : { completedAt: step.completed_at as string | null }),
    };
  });
  return {
    id: value.id as number,
    name: value.name,
    ...(value.run_id === undefined ? {} : { runId: value.run_id as number }),
    ...(value.run_attempt === undefined ? {} : { runAttempt: value.run_attempt as number }),
    ...(value.head_sha === undefined ? {} : { headSha: value.head_sha }),
    ...(value.run_url === undefined ? {} : { runUrl: value.run_url }),
    ...(value.url === undefined ? {} : { apiUrl: value.url }),
    ...(value.html_url === undefined ? {} : { htmlUrl: value.html_url }),
    ...(value.check_run_url === undefined ? {} : { checkRunUrl: value.check_run_url }),
    ...(value.status === undefined ? {} : { status: value.status }),
    conclusion: value.conclusion,
    ...(value.runner_id === undefined ? {} : { runnerId: value.runner_id as number | null }),
    ...(value.runner_name === undefined ? {} : { runnerName: value.runner_name }),
    ...(value.runner_group_id === undefined
      ? {}
      : { runnerGroupId: value.runner_group_id as number | null }),
    ...(value.runner_group_name === undefined ? {} : { runnerGroupName: value.runner_group_name }),
    ...(value.labels === undefined ? {} : { labels: value.labels as string[] }),
    ...(value.started_at === undefined ? {} : { startedAt: value.started_at as string | null }),
    ...(value.completed_at === undefined
      ? {}
      : { completedAt: value.completed_at as string | null }),
    steps,
  };
}

function validateWorkflowJobAnnotation(value: unknown): WorkflowJobAnnotation {
  if (!isObjectRecord(value)) {
    throw new Error("GitHub returned an invalid workflow job annotation");
  }
  const title = value.title === null ? "" : value.title;
  const rawDetails = value.raw_details === null ? "" : value.raw_details;
  if (
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    Buffer.byteLength(value.path, "utf8") > MAX_JOB_ANNOTATION_IDENTITY_BYTES ||
    typeof value.blob_href !== "string" ||
    Buffer.byteLength(value.blob_href, "utf8") > MAX_JOB_ANNOTATION_IDENTITY_BYTES ||
    !Number.isSafeInteger(value.start_line) ||
    (value.start_line as number) < 1 ||
    (value.start_column !== null &&
      (!Number.isSafeInteger(value.start_column) || (value.start_column as number) < 1)) ||
    !Number.isSafeInteger(value.end_line) ||
    (value.end_line as number) < (value.start_line as number) ||
    (value.end_column !== null &&
      (!Number.isSafeInteger(value.end_column) || (value.end_column as number) < 1)) ||
    typeof value.annotation_level !== "string" ||
    Buffer.byteLength(value.annotation_level, "utf8") > MAX_JOB_ANNOTATION_IDENTITY_BYTES ||
    typeof title !== "string" ||
    Buffer.byteLength(title, "utf8") > MAX_JOB_ANNOTATION_TEXT_BYTES ||
    typeof value.message !== "string" ||
    Buffer.byteLength(value.message, "utf8") > MAX_JOB_ANNOTATION_TEXT_BYTES ||
    typeof rawDetails !== "string" ||
    Buffer.byteLength(rawDetails, "utf8") > MAX_JOB_ANNOTATION_TEXT_BYTES
  ) {
    throw new Error("GitHub returned an invalid workflow job annotation");
  }
  return {
    path: value.path,
    blobHref: value.blob_href,
    startLine: value.start_line as number,
    startColumn: value.start_column as number | null,
    endLine: value.end_line as number,
    endColumn: value.end_column as number | null,
    annotationLevel: value.annotation_level,
    title,
    message: value.message,
    rawDetails,
  };
}

async function listWorkflowJobAnnotations(
  repository: string,
  token: string,
  job: WorkflowJob,
  runId: number,
  runAttempt: number,
): Promise<{
  annotations: WorkflowJobAnnotation[];
  checkEvidence: WorkflowJobCheckEvidence;
}> {
  const apiRepository = `https://api.github.com/repos/${repository}`;
  const webRepository = `https://github.com/${repository}`;
  const expectedRunUrl = `${apiRepository}/actions/runs/${runId}`;
  const expectedJobUrl = `${apiRepository}/actions/jobs/${job.id}`;
  const expectedCheckRunUrl = `${apiRepository}/check-runs/${job.id}`;
  const expectedHtmlUrl = `${webRepository}/actions/runs/${runId}/job/${job.id}`;
  if (
    !job.headSha ||
    job.runId !== runId ||
    job.runAttempt !== runAttempt ||
    job.runUrl !== expectedRunUrl ||
    job.apiUrl !== expectedJobUrl ||
    job.htmlUrl !== expectedHtmlUrl ||
    job.checkRunUrl !== expectedCheckRunUrl
  ) {
    throw new Error("workflow job identity does not match its exact run attempt");
  }
  const check = await githubApi<unknown>(`repos/${repository}/check-runs/${job.id}`, token, {
    userAgent: USER_AGENT,
  });
  const expectedAnnotationsUrl = `${expectedCheckRunUrl}/annotations`;
  if (
    !isObjectRecord(check) ||
    check.id !== job.id ||
    check.name !== job.name ||
    check.head_sha !== job.headSha ||
    check.url !== expectedCheckRunUrl ||
    check.html_url !== expectedHtmlUrl ||
    check.details_url !== expectedHtmlUrl ||
    check.status !== "completed" ||
    check.conclusion !== job.conclusion ||
    !isObjectRecord(check.app) ||
    check.app.id !== GITHUB_ACTIONS_APP_ID ||
    check.app.slug !== "github-actions" ||
    !isObjectRecord(check.output) ||
    !Number.isSafeInteger(check.output.annotations_count) ||
    (check.output.annotations_count as number) < 0 ||
    check.output.annotations_url !== expectedAnnotationsUrl
  ) {
    throw new Error("workflow job check run does not match the exact failed job");
  }
  const expectedCount = check.output.annotations_count as number;
  const checkEvidence: WorkflowJobCheckEvidence = {
    id: check.id as number,
    name: check.name as string,
    headSha: check.head_sha as string,
    apiUrl: check.url as string,
    htmlUrl: check.html_url as string,
    detailsUrl: check.details_url as string,
    status: check.status as string,
    conclusion: check.conclusion as string,
    appId: check.app.id as number,
    appSlug: check.app.slug as string,
    annotationsCount: expectedCount,
    annotationsUrl: check.output.annotations_url as string,
  };
  if (expectedCount > MAX_RUNNER_LOSS_JOB_ANNOTATIONS) {
    throw new Error("workflow job annotation count exceeds the hosted-runner-loss limit");
  }
  const annotations: WorkflowJobAnnotation[] = [];
  const fingerprints = new Set<string>();
  let annotationBytes = 0;
  for (let page = 1; page <= MAX_JOB_ANNOTATION_PAGES; page += 1) {
    const value = await githubApi<unknown>(
      `repos/${repository}/check-runs/${job.id}/annotations?per_page=${MAX_RUNNER_LOSS_JOB_ANNOTATIONS}&page=${page}`,
      token,
      { userAgent: USER_AGENT },
    );
    if (!Array.isArray(value) || value.length > MAX_RUNNER_LOSS_JOB_ANNOTATIONS) {
      throw new Error("GitHub returned an invalid workflow job annotation listing");
    }
    const pageAnnotations = value.map(validateWorkflowJobAnnotation);
    for (const annotation of pageAnnotations) {
      const fingerprint = JSON.stringify(annotation);
      if (fingerprints.has(fingerprint)) {
        throw new Error("GitHub returned duplicate workflow job annotations");
      }
      fingerprints.add(fingerprint);
      annotationBytes += Buffer.byteLength(fingerprint, "utf8");
      if (annotationBytes > MAX_RUNNER_LOSS_JOB_ANNOTATION_BYTES) {
        throw new Error("workflow job annotation evidence exceeds its byte limit");
      }
      annotations.push(annotation);
    }
    if (annotations.length > expectedCount) {
      throw new Error("workflow job annotation listing exceeds the trusted annotation count");
    }
    if (annotations.length === expectedCount) return { annotations, checkEvidence };
    if (value.length < MAX_RUNNER_LOSS_JOB_ANNOTATIONS) {
      throw new Error("workflow job annotation listing is incomplete");
    }
  }
  throw new Error("workflow job annotation listing exceeded its page limit");
}

function parseJobLogContentLength(value: string | null, label: string): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} did not provide a valid content length`);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`${label} content length is outside the safe integer range`);
  }
  return length;
}

function validateJobLogEtag(value: string | null): string {
  if (!value || value.length > 130 || !/^"[^"\r\n]{1,128}"$/u.test(value)) {
    throw new Error("job log download did not provide a strong bounded ETag");
  }
  return value;
}

function validateJobLogDownloadUrl(value: string | null): URL {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error("job log API returned an invalid signed download URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !JOB_LOG_DOWNLOAD_HOST_PATTERN.test(url.hostname) ||
    !url.pathname.startsWith("/actions-results/") ||
    url.search.length < 2 ||
    url.hash !== ""
  ) {
    throw new Error("job log API returned an untrusted signed download URL");
  }
  return url;
}

function assertPlainUnencodedJobLog(response: Response, label: string): void {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "text/plain" || response.headers.get("content-encoding") !== null) {
    throw new Error(`${label} did not return unencoded plain text`);
  }
}

async function cancelJobLogResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readExactJobLogRange(
  response: Response,
  expectedBytes: number,
  discardPartialFirstLine: boolean,
): Promise<string> {
  if (!response.body) throw new Error("job log range response did not include a body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > expectedBytes || receivedBytes > MAX_RUNNER_LOSS_JOB_LOG_TAIL_BYTES) {
        throw new Error("job log range response exceeded its authenticated byte bound");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (receivedBytes !== expectedBytes) {
    throw new Error("job log range response was incomplete");
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const firstLineFeed = discardPartialFirstLine ? bytes.indexOf(0x0a) : -1;
  if (discardPartialFirstLine && firstLineFeed < 0) {
    throw new Error("job log range did not contain a complete record");
  }
  const completeRecords = firstLineFeed < 0 ? bytes : bytes.subarray(firstLineFeed + 1);
  return new TextDecoder("utf-8", { fatal: true }).decode(completeRecords);
}

async function downloadWorkflowJobLogTail(
  repository: string,
  token: string,
  jobId: number,
): Promise<WorkflowJobLogEvidence> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUNNER_LOSS_JOB_LOG_TIMEOUT_MS);
  const apiUrl = `https://api.github.com/repos/${repository}/actions/jobs/${jobId}/logs`;
  try {
    const redirect = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (redirect.status !== 302) {
      await cancelJobLogResponseBody(redirect);
      throw new Error(`job log API returned unexpected status ${redirect.status}`);
    }
    const location = redirect.headers.get("location");
    await cancelJobLogResponseBody(redirect);
    const downloadUrl = validateJobLogDownloadUrl(location);

    const downloadHeaders = {
      Accept: "text/plain",
      "Accept-Encoding": "identity",
      "User-Agent": USER_AGENT,
    };
    const metadata = await fetch(downloadUrl, {
      method: "HEAD",
      headers: downloadHeaders,
      redirect: "error",
      signal: controller.signal,
    });
    if (metadata.status !== 200) {
      await cancelJobLogResponseBody(metadata);
      throw new Error(`job log metadata returned unexpected status ${metadata.status}`);
    }
    let totalBytes: number;
    let etag: string;
    try {
      assertPlainUnencodedJobLog(metadata, "job log metadata");
      totalBytes = parseJobLogContentLength(
        metadata.headers.get("content-length"),
        "job log metadata",
      );
      if (totalBytes < 1) throw new Error("job log is empty");
      etag = validateJobLogEtag(metadata.headers.get("etag"));
    } catch (error) {
      await cancelJobLogResponseBody(metadata);
      throw error;
    }
    await cancelJobLogResponseBody(metadata);

    const rangeStart = Math.max(0, totalBytes - MAX_RUNNER_LOSS_JOB_LOG_TAIL_BYTES);
    const rangeEnd = totalBytes - 1;
    const expectedBytes = rangeEnd - rangeStart + 1;
    const range = await fetch(downloadUrl, {
      headers: {
        ...downloadHeaders,
        "If-Match": etag,
        Range: `bytes=${rangeStart}-${rangeEnd}`,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (range.status !== 206) {
      await cancelJobLogResponseBody(range);
      throw new Error(`job log range returned unexpected status ${range.status}`);
    }
    try {
      assertPlainUnencodedJobLog(range, "job log range");
      if (
        range.headers.get("etag") !== etag ||
        range.headers.get("content-range") !== `bytes ${rangeStart}-${rangeEnd}/${totalBytes}` ||
        parseJobLogContentLength(range.headers.get("content-length"), "job log range") !==
          expectedBytes
      ) {
        throw new Error("job log range did not match its authenticated metadata");
      }
    } catch (error) {
      await cancelJobLogResponseBody(range);
      throw error;
    }
    return {
      etag,
      totalBytes,
      tail: await readExactJobLogRange(range, expectedBytes, rangeStart > 0),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validateWorkflowJobsPage(value: unknown): WorkflowJobsPage {
  if (
    !isObjectRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.jobs)
  ) {
    throw new Error("GitHub returned an invalid workflow job listing");
  }
  return {
    totalCount: value.total_count as number,
    jobs: value.jobs.map(validateWorkflowJob),
  };
}

export async function listNonPassingWorkflowJobs(
  repository: string,
  token: string,
  runId: number,
  runAttempt: number,
  options: {
    includeAnnotations?: boolean;
    hostedRunnerLossPolicy?: HostedRunnerLossPolicy;
  } = {},
): Promise<{ jobs: WorkflowJob[]; complete: boolean }> {
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1
  ) {
    throw new Error("workflow run and attempt IDs must be positive safe integers");
  }
  const jobs: WorkflowJob[] = [];
  const jobIds = new Set<number>();
  let totalCount: number | undefined;
  for (let page = 1; page <= MAX_WORKFLOW_JOB_PAGES; page += 1) {
    const response = validateWorkflowJobsPage(
      await githubApi<unknown>(
        `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`,
        token,
        { userAgent: USER_AGENT },
      ),
    );
    totalCount ??= response.totalCount;
    if (response.totalCount !== totalCount || jobs.length + response.jobs.length > totalCount) {
      throw new Error("GitHub returned an invalid workflow job count");
    }
    for (const job of response.jobs) {
      if (jobIds.has(job.id)) {
        throw new Error("GitHub returned duplicate workflow job IDs across the job listing");
      }
      jobIds.add(job.id);
    }
    jobs.push(...response.jobs);
    if (jobs.length === totalCount) {
      const nonPassingJobs = jobs.filter(
        (job) => !["success", "skipped", "neutral"].includes(job.conclusion ?? ""),
      );
      if (options.includeAnnotations) {
        const hostedRunnerLossPolicy = options.hostedRunnerLossPolicy ?? {};
        const runnerLossCandidates = nonPassingJobs.filter((job) =>
          isHostedRunnerLossInspectionCandidate(job, hostedRunnerLossPolicy),
        );
        if (runnerLossCandidates.length > MAX_RUNNER_LOSS_JOB_INSPECTIONS) {
          throw new Error("workflow run exceeded the hosted-runner-loss inspection limit");
        }
        for (const job of runnerLossCandidates) {
          const evidence = await listWorkflowJobAnnotations(
            repository,
            token,
            job,
            runId,
            runAttempt,
          );
          job.annotations = evidence.annotations;
          job.checkEvidence = evidence.checkEvidence;
          const workflowSha = job.headSha ?? "";
          if (needsHostedRunnerShutdownLog(job, repository, workflowSha, hostedRunnerLossPolicy)) {
            try {
              job.logEvidence = await downloadWorkflowJobLogTail(repository, token, job.id);
            } catch {
              console.warn(
                `Could not authenticate hosted-runner shutdown log for job ${job.id}; automatic retry remains disabled`,
              );
            }
          }
        }
      }
      return {
        jobs: nonPassingJobs,
        complete: true,
      };
    }
    if (response.jobs.length < 100) break;
  }
  return {
    jobs: jobs.filter((job) => !["success", "skipped", "neutral"].includes(job.conclusion ?? "")),
    complete: jobs.length === totalCount,
  };
}

export function workflowJobEvidenceFingerprint(details: {
  jobs: readonly WorkflowJob[];
  complete: boolean;
}): string {
  const jobs = [...details.jobs]
    .sort((left, right) => left.id - right.id)
    .map((job) => {
      const { annotations, logEvidence, ...metadata } = job;
      return {
        ...metadata,
        ...(annotations === undefined
          ? {}
          : { annotations: annotations.map((annotation) => JSON.stringify(annotation)).sort() }),
        ...(logEvidence === undefined
          ? {}
          : {
              logEvidence: {
                etag: logEvidence.etag,
                totalBytes: logEvidence.totalBytes,
                tailHash: sha256(logEvidence.tail),
              },
            }),
      };
    });
  return sha256(JSON.stringify({ complete: details.complete, jobs }));
}
