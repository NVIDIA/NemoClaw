// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  decodeJetsonArtifactArchive,
  JETSON_DISPATCH_AUDIENCE,
  JETSON_DISPATCH_TARGET,
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
  if (!response.body) throw new Error("Jetson dispatcher returned an empty response");
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

export async function pollJetsonDispatch(options: {
  baseUrl: URL;
  deadlineMs: number;
  initialStatus: JetsonDispatchStatus;
  jobId: string;
  now?: () => number;
  request?: typeof dispatcherRequest;
  stopping?: () => boolean;
  wait?: typeof delay;
}): Promise<JetsonDispatchStatus> {
  const now = options.now ?? Date.now;
  const request = options.request ?? dispatcherRequest;
  const wait = options.wait ?? delay;
  let consecutiveFailures = 0;
  let status = options.initialStatus;
  if (status.jobId !== options.jobId) {
    throw new Error("Jetson dispatcher status does not match the accepted job");
  }
  while (status.state !== "completed") {
    if (options.stopping?.()) throw new Error("Jetson dispatch cancellation requested");
    if (now() >= options.deadlineMs) {
      await request({
        baseUrl: options.baseUrl,
        method: "DELETE",
        path: `v1/jobs/${options.jobId}`,
        maxBytes: MAX_STATUS_BYTES,
      }).catch(() => undefined);
      throw new Error("Jetson dispatcher did not complete before the controller deadline");
    }
    await wait(POLL_INTERVAL_MS);
    try {
      status = parseJetsonDispatchStatusResponse(
        await request({
          baseUrl: options.baseUrl,
          method: "GET",
          path: `v1/jobs/${options.jobId}`,
          maxBytes: MAX_STATUS_BYTES,
        }),
        options.initialStatus.request,
      );
      if (status.jobId !== options.jobId) {
        throw new Error("Jetson dispatcher status does not match the accepted job");
      }
      consecutiveFailures = 0;
      console.log(`Jetson dispatch state: ${status.state}`);
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        await request({
          baseUrl: options.baseUrl,
          method: "DELETE",
          path: `v1/jobs/${options.jobId}`,
          maxBytes: MAX_STATUS_BYTES,
        }).catch(() => undefined);
        throw error;
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

  let jobId: string | undefined;
  let stopping = false;
  const cancel = (): void => {
    if (stopping) return;
    stopping = true;
    if (!jobId) {
      process.exitCode = 1;
      return;
    }
    void dispatcherRequest({
      baseUrl,
      method: "DELETE",
      path: `v1/jobs/${jobId}`,
      maxBytes: MAX_STATUS_BYTES,
    }).finally(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);

  const dispatched = parseJetsonDispatchStatusResponse(
    await dispatcherRequest({
      baseUrl,
      method: "POST",
      path: "v1/jobs",
      body: request,
      maxBytes: MAX_STATUS_BYTES,
    }),
    request,
  );
  jobId = dispatched.jobId;
  console.log(`Jetson dispatch accepted as ${jobId}`);
  const deadline = Date.now() + MAX_WAIT_MS;
  await pollJetsonDispatch({
    baseUrl,
    deadlineMs: deadline,
    initialStatus: dispatched,
    jobId,
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
  writePrivateRegularFile(
    path.join(artifactDirectory, "jetson-dispatch.json"),
    `${JSON.stringify(artifactReceipt, null, 2)}\n`,
  );
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
