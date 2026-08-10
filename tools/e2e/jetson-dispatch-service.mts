// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createGitHubJwksResolver,
  type GitHubOidcIdentity,
  parseJetsonDispatchRequest,
  type SigningKeyResolver,
  verifyGitHubOidcToken,
} from "./jetson-dispatch-contract.mts";
import {
  JetsonDispatchBusyError,
  JetsonDispatchCoordinator,
  JetsonDispatchNotFoundError,
} from "./jetson-dispatch-lifecycle.mts";
import { loadSshJetsonWorkerConfig, SshJetsonDispatchWorker } from "./jetson-dispatch-worker.mts";

const MAX_REQUEST_BYTES = 8 * 1024;
const JOB_PATH_PATTERN = /^\/v1\/jobs\/([a-f0-9]{64})(?:\/(artifact))?$/u;

function positiveIntegerEnvironment(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string" ? /^Bearer ([A-Za-z0-9._-]+)$/u.exec(authorization) : null;
  if (!match) throw new Error("request requires a bearer token");
  return match[1]!;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new Error("request Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

export function createJetsonDispatchServer(options: {
  coordinator: JetsonDispatchCoordinator;
  repositoryId: string;
  resolveSigningKey: SigningKeyResolver;
}): Server {
  async function authenticate(
    token: string,
    dispatchRequest: ReturnType<JetsonDispatchCoordinator["request"]>,
  ): Promise<GitHubOidcIdentity> {
    return verifyGitHubOidcToken({
      token,
      request: dispatchRequest,
      policy: { repositoryId: options.repositoryId },
      resolveSigningKey: options.resolveSigningKey,
    });
  }

  return createServer((request, response) => {
    void (async () => {
      if (!request.url) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      let token: string;
      try {
        token = bearerToken(request);
      } catch {
        sendJson(response, 401, { error: "request authentication failed" });
        return;
      }
      const createJob = request.method === "POST" && request.url === "/v1/jobs";
      const match = JOB_PATH_PATTERN.exec(request.url);
      if (!createJob && (!match || !["DELETE", "GET"].includes(request.method ?? ""))) {
        sendJson(response, 404, { error: "not found" });
        return;
      }

      let dispatchRequest;
      let jobId: string | undefined;
      let artifact = false;
      if (createJob) {
        try {
          dispatchRequest = parseJetsonDispatchRequest(await readJsonBody(request));
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "invalid request",
          });
          return;
        }
      } else {
        jobId = match![1]!;
        artifact = match![2] === "artifact";
        try {
          dispatchRequest = options.coordinator.request(jobId);
        } catch {
          sendJson(response, 401, { error: "request authentication failed" });
          return;
        }
      }

      let identity;
      try {
        identity = await authenticate(token, dispatchRequest);
      } catch {
        sendJson(response, 401, { error: "request authentication failed" });
        return;
      }
      if (createJob) {
        sendJson(response, 202, { job: options.coordinator.dispatch(dispatchRequest, identity) });
        return;
      }

      const existingJobId = jobId!;
      if (request.method === "DELETE") {
        if (artifact) {
          sendJson(response, 405, { error: "method not allowed" });
          return;
        }
        sendJson(response, 202, { job: options.coordinator.cancel(existingJobId) });
        return;
      }
      sendJson(
        response,
        200,
        artifact
          ? options.coordinator.artifact(existingJobId)
          : { job: options.coordinator.status(existingJobId) },
      );
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof JetsonDispatchBusyError) {
        sendJson(response, 409, { error: error.message });
        return;
      }
      if (error instanceof JetsonDispatchNotFoundError) {
        sendJson(response, 404, { error: error.message });
        return;
      }
      console.error("Jetson dispatch service failed");
      sendJson(response, 500, { error: "Jetson dispatch service failed" });
    });
  });
}

async function main(): Promise<void> {
  const stateDirectory = process.env.JETSON_DISPATCH_STATE_DIRECTORY ?? "";
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("JETSON_DISPATCH_STATE_DIRECTORY must be absolute");
  }
  const repositoryId = process.env.JETSON_DISPATCH_GITHUB_REPOSITORY_ID ?? "";
  if (!/^[1-9][0-9]*$/u.test(repositoryId)) {
    throw new Error("JETSON_DISPATCH_GITHUB_REPOSITORY_ID must be a positive integer");
  }
  const executionTimeoutSeconds = positiveIntegerEnvironment(
    process.env.JETSON_DISPATCH_EXECUTION_TIMEOUT_SECONDS,
    "JETSON_DISPATCH_EXECUTION_TIMEOUT_SECONDS",
    120,
    55 * 60,
  );
  const cleanupTimeoutSeconds = positiveIntegerEnvironment(
    process.env.JETSON_DISPATCH_CLEANUP_TIMEOUT_SECONDS,
    "JETSON_DISPATCH_CLEANUP_TIMEOUT_SECONDS",
    10,
    10 * 60,
  );
  const workerConfig = loadSshJetsonWorkerConfig({ stateDirectory });
  if (executionTimeoutSeconds < workerConfig.testTimeoutSeconds + 30) {
    throw new Error("Jetson execution timeout must exceed the remote test timeout by 30 seconds");
  }
  const coordinator = new JetsonDispatchCoordinator({
    stateDirectory,
    worker: new SshJetsonDispatchWorker(workerConfig),
    executionTimeoutMs: executionTimeoutSeconds * 1_000,
    cleanupTimeoutMs: cleanupTimeoutSeconds * 1_000,
  });
  await coordinator.initialize();
  const server = createJetsonDispatchServer({
    coordinator,
    repositoryId,
    resolveSigningKey: createGitHubJwksResolver(),
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const port = positiveIntegerEnvironment(
    process.env.JETSON_DISPATCH_PORT ?? "8787",
    "JETSON_DISPATCH_PORT",
    1,
    65_535,
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`Jetson dispatch service listening on 127.0.0.1:${port}`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
      .then(() => coordinator.shutdown())
      .catch((error) => {
        console.error(error instanceof Error ? error.message : "Jetson dispatch shutdown failed");
        process.exitCode = 1;
      });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Jetson dispatch service failed");
    process.exitCode = 1;
  });
}
