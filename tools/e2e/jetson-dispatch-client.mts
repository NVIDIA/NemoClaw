// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  decodeJetsonArtifactArchive,
  JETSON_DISPATCH_AUDIENCE,
  JETSON_DISPATCH_TARGET,
  jetsonDispatchJobId,
  type JetsonDispatchArtifact,
  type JetsonDispatchRequest,
  type JetsonDispatchStatus,
  MAX_JETSON_DISPATCH_ARTIFACT_RESPONSE_BYTES,
  parseJetsonDispatchArtifact,
  parseJetsonDispatchRequest,
  parseJetsonDispatchStatusResponse,
} from "./jetson-dispatch-contract.mts";
import { writePrivateRegularFile } from "./private-file.mts";

const MAX_STATUS_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 54 * 60_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const OIDC_TOKEN_CACHE_MS = 4 * 60_000;

type JetsonCancellationFailure =
  | "authorization-failed"
  | "dispatcher-http-error"
  | "invalid-response"
  | "job-not-found"
  | "request-timeout"
  | "transport-error";
type JetsonCancellationReason =
  | "controller-deadline"
  | "recovery-receipt-failure"
  | "signal"
  | "submission-outcome-unknown"
  | "status-request-failures";
type JetsonCancellationResult =
  | { outcome: "failed"; failure: JetsonCancellationFailure; receiptWritten: boolean }
  | { outcome: "succeeded"; receiptWritten: boolean };

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function dispatcherBaseUrl(value: string | undefined): URL {
  if (!value) throw new Error("JETSON_DISPATCH_URL is required");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("JETSON_DISPATCH_URL must be an HTTPS origin without credentials or a path");
  }
  url.pathname = "/";
  return url;
}

export function createGitHubOidcTokenProvider(
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): (env?: NodeJS.ProcessEnv) => Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cached:
    | { expiresAtMs: number; requestToken: string; requestUrlValue: string; value: string }
    | undefined;
  return async (env: NodeJS.ProcessEnv = process.env): Promise<string> => {
    const requestUrlValue = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!requestUrlValue || !requestToken) {
      throw new Error("GitHub OIDC environment is unavailable");
    }
    if (
      cached &&
      cached.requestUrlValue === requestUrlValue &&
      cached.requestToken === requestToken &&
      now() < cached.expiresAtMs
    ) {
      return cached.value;
    }
    const requestUrl = new URL(requestUrlValue);
    if (requestUrl.protocol !== "https:") {
      throw new Error("GitHub OIDC request URL must use HTTPS");
    }
    requestUrl.searchParams.set("audience", JETSON_DISPATCH_AUDIENCE);
    const response = await fetchImpl(requestUrl, {
      headers: { Authorization: `Bearer ${requestToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub OIDC token request returned HTTP ${response.status}`);
    }
    const payload = record(await response.json(), "GitHub OIDC token response");
    if (
      typeof payload.value !== "string" ||
      payload.value.length === 0 ||
      payload.value.length > 16 * 1024
    ) {
      throw new Error("GitHub OIDC token response is invalid");
    }
    cached = {
      expiresAtMs: now() + OIDC_TOKEN_CACHE_MS,
      requestToken,
      requestUrlValue,
      value: payload.value,
    };
    return payload.value;
  };
}

const githubOidcToken = createGitHubOidcTokenProvider();

export async function dispatcherRequest(options: {
  baseUrl: URL;
  method: "DELETE" | "GET" | "POST";
  path: string;
  body?: unknown;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  tokenProvider?: () => Promise<string>;
}): Promise<unknown> {
  const token = await (options.tokenProvider ?? githubOidcToken)();
  const response = await (options.fetchImpl ?? fetch)(new URL(options.path, options.baseUrl), {
    method: options.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15_000),
  });
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^[0-9]+$/u.test(contentLength) &&
    Number(contentLength) > options.maxBytes
  ) {
    throw new Error("Jetson dispatcher response is too large");
  }
  if (!response.body) {
    if (response.ok && options.method === "DELETE") return undefined;
    throw new Error("Jetson dispatcher returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    responseBytes += value.length;
    if (responseBytes > options.maxBytes) {
      await reader.cancel();
      throw new Error("Jetson dispatcher response is too large");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, responseBytes);
  if (responseBytes === 0) {
    if (response.ok && options.method === "DELETE") return undefined;
    throw new Error("Jetson dispatcher returned an empty response");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Jetson dispatcher returned invalid JSON");
  }
  if (!response.ok) {
    const error = record(payload, "Jetson dispatcher error").error;
    throw new Error(
      `Jetson dispatcher returned HTTP ${response.status}: ${typeof error === "string" ? error.slice(0, 500) : "request failed"}`,
    );
  }
  return payload;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeJetsonRecoveryReceipt(
  receiptFile: string,
  dispatch: Pick<JetsonDispatchStatus, "jobId" | "request">,
  cancellation?: {
    failure?: JetsonCancellationFailure;
    outcome: "failed" | "pending" | "succeeded";
    reason: JetsonCancellationReason;
  },
): void {
  writePrivateRegularFile(
    receiptFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        jobId: dispatch.jobId,
        request: dispatch.request,
        ...(cancellation === undefined ? {} : { cancellation }),
      },
      null,
      2,
    )}\n`,
  );
}

function classifyCancellationFailure(error: unknown): JetsonCancellationFailure {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "request-timeout";
  }
  if (/returned HTTP (?:401|403)(?::|$)/u.test(message)) return "authorization-failed";
  if (/returned HTTP 404(?::|$)/u.test(message)) return "job-not-found";
  if (/returned HTTP [0-9]{3}(?::|$)/u.test(message)) return "dispatcher-http-error";
  if (/empty response|invalid JSON|response is too large|must be an object/u.test(message)) {
    return "invalid-response";
  }
  return "transport-error";
}

async function cancelJetsonDispatch(options: {
  baseUrl: URL;
  dispatch: Pick<JetsonDispatchStatus, "jobId" | "request">;
  reason: JetsonCancellationReason;
  receiptFile: string;
  request: typeof dispatcherRequest;
}): Promise<JetsonCancellationResult> {
  const cancellation = { outcome: "pending", reason: options.reason } as const;
  try {
    writeJetsonRecoveryReceipt(options.receiptFile, options.dispatch, cancellation);
  } catch {
    // The cancellation request must continue when the local recovery receipt cannot be updated.
  }

  let result: { outcome: "failed"; failure: JetsonCancellationFailure } | { outcome: "succeeded" };
  try {
    await options.request({
      baseUrl: options.baseUrl,
      method: "DELETE",
      path: `v1/jobs/${options.dispatch.jobId}`,
      maxBytes: MAX_STATUS_BYTES,
    });
    result = { outcome: "succeeded" };
  } catch (error) {
    result = { outcome: "failed", failure: classifyCancellationFailure(error) };
  }

  let receiptWritten = true;
  try {
    writeJetsonRecoveryReceipt(options.receiptFile, options.dispatch, {
      outcome: result.outcome,
      reason: options.reason,
      ...(result.outcome === "failed" ? { failure: result.failure } : {}),
    });
  } catch {
    receiptWritten = false;
  }
  return { ...result, receiptWritten } as JetsonCancellationResult;
}

function cancellationResultMessage(result: JetsonCancellationResult): string {
  const outcome =
    result.outcome === "succeeded"
      ? "cancellation request succeeded"
      : `cancellation request failed (${result.failure})`;
  return result.receiptWritten ? outcome : `${outcome}; recovery receipt update failed`;
}

export type CancelJetsonDispatch = (
  reason: JetsonCancellationReason,
  options?: { retryJobNotFound?: boolean },
) => Promise<JetsonCancellationResult>;

export function createJetsonCancellation(options: {
  baseUrl: URL;
  dispatch: Pick<JetsonDispatchStatus, "jobId" | "request">;
  receiptFile: string;
  request: typeof dispatcherRequest;
}): CancelJetsonDispatch {
  let inFlight: Promise<JetsonCancellationResult> | undefined;
  let retry: Promise<JetsonCancellationResult> | undefined;
  return (reason, callOptions) => {
    inFlight ??= cancelJetsonDispatch({ ...options, reason });
    if (!callOptions?.retryJobNotFound) return inFlight;
    retry ??= inFlight.then((result) =>
      result.outcome === "failed" && result.failure === "job-not-found"
        ? cancelJetsonDispatch({ ...options, reason })
        : result,
    );
    return retry;
  };
}

export async function submitJetsonDispatch(options: {
  baseUrl: URL;
  cancel?: CancelJetsonDispatch;
  dispatchRequest: JetsonDispatchRequest;
  receiptFile: string;
  request?: typeof dispatcherRequest;
  stopping?: () => boolean;
}): Promise<{ cancel: CancelJetsonDispatch; status: JetsonDispatchStatus }> {
  const jobId = jetsonDispatchJobId(options.dispatchRequest);
  const dispatch = { jobId, request: options.dispatchRequest };
  writeJetsonRecoveryReceipt(options.receiptFile, dispatch);
  if (options.stopping?.()) {
    throw new Error(`Jetson dispatch ${jobId} stopped before submission`);
  }
  const request = options.request ?? dispatcherRequest;
  const cancel =
    options.cancel ??
    createJetsonCancellation({
      baseUrl: options.baseUrl,
      dispatch,
      receiptFile: options.receiptFile,
      request,
    });

  let status: JetsonDispatchStatus;
  try {
    status = parseJetsonDispatchStatusResponse(
      await request({
        baseUrl: options.baseUrl,
        method: "POST",
        path: "v1/jobs",
        body: options.dispatchRequest,
        maxBytes: MAX_STATUS_BYTES,
      }),
      options.dispatchRequest,
    );
  } catch {
    const reason = options.stopping?.() ? "signal" : "submission-outcome-unknown";
    const cancellation = await cancel(reason, { retryJobNotFound: true });
    throw new Error(
      `Jetson dispatch ${jobId} submission outcome was not confirmed; ${cancellationResultMessage(cancellation)}`,
    );
  }
  if (options.stopping?.()) {
    const cancellation = await cancel("signal", { retryJobNotFound: true });
    throw new Error(
      `Jetson dispatch ${jobId} cancellation requested; ${cancellationResultMessage(cancellation)}`,
    );
  }
  return { cancel, status };
}

export async function pollJetsonDispatch(options: {
  baseUrl: URL;
  cancel?: CancelJetsonDispatch;
  deadlineMs: number;
  initialStatus: JetsonDispatchStatus;
  now?: () => number;
  receiptFile: string;
  request?: typeof dispatcherRequest;
  stopping?: () => boolean;
  wait?: typeof delay;
}): Promise<JetsonDispatchStatus> {
  const now = options.now ?? Date.now;
  const request = options.request ?? dispatcherRequest;
  const jobId = options.initialStatus.jobId;
  const cancel =
    options.cancel ??
    createJetsonCancellation({
      baseUrl: options.baseUrl,
      dispatch: options.initialStatus,
      receiptFile: options.receiptFile,
      request,
    });
  const wait = options.wait ?? delay;
  let consecutiveFailures = 0;
  let status = options.initialStatus;
  try {
    writeJetsonRecoveryReceipt(options.receiptFile, status);
  } catch {
    const cancellation = await cancel("recovery-receipt-failure");
    throw new Error(
      `Jetson dispatch ${jobId} was accepted but its recovery receipt could not be written; ${cancellationResultMessage(cancellation)}`,
    );
  }
  while (status.state !== "completed") {
    if (options.stopping?.()) {
      const cancellation = await cancel("signal");
      throw new Error(
        `Jetson dispatch ${jobId} cancellation requested; ${cancellationResultMessage(cancellation)}`,
      );
    }
    if (now() >= options.deadlineMs) {
      const cancellation = await cancel("controller-deadline");
      throw new Error(
        `Jetson dispatch ${jobId} did not complete before the controller deadline; ${cancellationResultMessage(cancellation)}`,
      );
    }
    await wait(POLL_INTERVAL_MS);
    try {
      status = parseJetsonDispatchStatusResponse(
        await request({
          baseUrl: options.baseUrl,
          method: "GET",
          path: `v1/jobs/${jobId}`,
          maxBytes: MAX_STATUS_BYTES,
        }),
        options.initialStatus.request,
      );
      if (status.jobId !== jobId) {
        throw new Error("Jetson dispatcher status does not match the accepted job");
      }
      consecutiveFailures = 0;
      console.log(`Jetson dispatch state: ${status.state}`);
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        const cancellation = await cancel("status-request-failures");
        throw new Error(
          `Jetson dispatch ${jobId} status failed ${MAX_CONSECUTIVE_POLL_FAILURES} consecutive times; ${cancellationResultMessage(cancellation)}`,
        );
      }
      console.warn("Jetson dispatch status request failed; retrying");
    }
  }
  return status;
}

export function jetsonDispatchRequestFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): JetsonDispatchRequest {
  return parseJetsonDispatchRequest({
    schemaVersion: 2,
    target: JETSON_DISPATCH_TARGET,
    candidateSha: environment.JETSON_DISPATCH_CANDIDATE_SHA,
    managedImageRevision: environment.JETSON_DISPATCH_MANAGED_IMAGE_REVISION,
    workflowRunId: environment.GITHUB_RUN_ID,
    workflowRunAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
  });
}

async function main(): Promise<void> {
  const request = jetsonDispatchRequestFromEnvironment();
  const baseUrl = dispatcherBaseUrl(process.env.JETSON_DISPATCH_URL);
  const artifactDirectory = process.env.E2E_ARTIFACT_DIR ?? "";
  if (!path.isAbsolute(artifactDirectory)) throw new Error("E2E_ARTIFACT_DIR must be absolute");
  fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactDirectory, 0o700);
  const receiptFile = path.join(artifactDirectory, "jetson-dispatch.json");

  const jobId = jetsonDispatchJobId(request);
  const cancelDispatch = createJetsonCancellation({
    baseUrl,
    dispatch: { jobId, request },
    receiptFile,
    request: dispatcherRequest,
  });
  let submissionStarted = false;
  let stopping = false;
  const cancel = (): void => {
    if (stopping) return;
    stopping = true;
    if (!submissionStarted) {
      process.exitCode = 1;
      return;
    }
    void cancelDispatch("signal").finally(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);

  submissionStarted = true;
  const submission = await submitJetsonDispatch({
    baseUrl,
    cancel: cancelDispatch,
    dispatchRequest: request,
    receiptFile,
    stopping: () => stopping,
  });
  const dispatched = submission.status;
  console.log(`Jetson dispatch accepted as ${jobId}`);
  const deadline = Date.now() + MAX_WAIT_MS;
  await pollJetsonDispatch({
    baseUrl,
    cancel: cancelDispatch,
    deadlineMs: deadline,
    initialStatus: dispatched,
    receiptFile,
    stopping: () => stopping,
  });

  const artifactValue = await dispatcherRequest({
    baseUrl,
    method: "GET",
    path: `v1/jobs/${jobId}/artifact`,
    maxBytes: MAX_JETSON_DISPATCH_ARTIFACT_RESPONSE_BYTES,
  });
  const artifact: JetsonDispatchArtifact = parseJetsonDispatchArtifact(artifactValue, jobId);
  const { artifactArchiveBase64, ...artifactReceipt } = artifact;
  writePrivateRegularFile(receiptFile, `${JSON.stringify(artifactReceipt, null, 2)}\n`);
  if (artifactArchiveBase64 !== undefined) {
    writePrivateRegularFile(
      path.join(artifactDirectory, "jetson-e2e-artifacts.tar.gz"),
      decodeJetsonArtifactArchive(artifactArchiveBase64),
    );
  }
  console.log(`Jetson dispatch conclusion: ${artifact.status.conclusion}`);
  if (artifact.status.conclusion !== "success") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Jetson dispatch client failed");
    process.exitCode = 1;
  });
}
