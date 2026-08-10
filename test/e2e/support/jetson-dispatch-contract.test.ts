// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubOidcTokenProvider,
  pollJetsonDispatch,
} from "../../../tools/e2e/jetson-dispatch-client.mts";
import {
  createGitHubJwksResolver,
  JETSON_DISPATCH_AUDIENCE,
  JETSON_DISPATCH_REPOSITORY,
  JETSON_DISPATCH_TARGET,
  JETSON_DISPATCH_WORKFLOW_REF,
  parseJetsonDispatchRequest,
  verifyGitHubOidcToken,
} from "../../../tools/e2e/jetson-dispatch-contract.mts";
import {
  JetsonDispatchBusyError,
  JetsonDispatchCoordinator,
  JetsonDispatchNotFoundError,
  type JetsonDispatchStatus,
  type JetsonDispatchWorker,
  MAX_JETSON_ARTIFACT_ARCHIVE_BYTES,
  MAX_JETSON_DISPATCH_ARTIFACT_RESPONSE_BYTES,
  MAX_JETSON_DISPATCH_LOG_BYTES,
} from "../../../tools/e2e/jetson-dispatch-lifecycle.mts";
import { createJetsonDispatchServer } from "../../../tools/e2e/jetson-dispatch-service.mts";

const NOW_SECONDS = 1_800_000_000;
const REPOSITORY_ID = "987654321";
const CANDIDATE_SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const ARTIFACT_ARCHIVE_BASE64 = Buffer.from("bounded archive").toString("base64");
const REQUEST = parseJetsonDispatchRequest({
  schemaVersion: 1,
  target: JETSON_DISPATCH_TARGET,
  candidateSha: CANDIDATE_SHA,
  workflowRunId: "123456789",
  workflowRunAttempt: 1,
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-jetson-dispatch-"));
  temporaryDirectories.push(directory);
  return directory;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: JETSON_DISPATCH_AUDIENCE,
    sub: "repo:NVIDIA/NemoClaw:ref:refs/heads/main",
    repository: JETSON_DISPATCH_REPOSITORY,
    repository_id: REPOSITORY_ID,
    workflow_ref: JETSON_DISPATCH_WORKFLOW_REF,
    workflow_sha: WORKFLOW_SHA,
    sha: WORKFLOW_SHA,
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    run_id: REQUEST.workflowRunId,
    run_attempt: String(REQUEST.workflowRunAttempt),
    jti: "token-id",
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 9 * 60,
    ...overrides,
  };
}

function signToken(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`, "ascii");
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}

function signingKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function identity() {
  return {
    repository: JETSON_DISPATCH_REPOSITORY,
    repositoryId: REPOSITORY_ID,
    runId: REQUEST.workflowRunId,
    runAttempt: REQUEST.workflowRunAttempt,
    workflowSha: WORKFLOW_SHA,
    tokenId: "token-id",
  } as const;
}

async function waitForCompletion(
  coordinator: JetsonDispatchCoordinator,
  jobId: string,
): Promise<JetsonDispatchStatus> {
  await vi.waitFor(() => expect(coordinator.status(jobId).state).toBe("completed"), {
    interval: 1,
    timeout: 1_000,
  });
  return coordinator.status(jobId);
}

function worker(
  options: { run?: JetsonDispatchWorker["run"]; reset?: JetsonDispatchWorker["reset"] } = {},
): JetsonDispatchWorker {
  return {
    run:
      options.run ??
      (async () => ({
        artifactArchiveBase64: ARTIFACT_ARCHIVE_BASE64,
        device: {
          model: "NVIDIA Jetson AGX Thor Developer Kit",
          jetpackVersion: "7.2.2",
          jetsonLinuxRelease: "R38",
          kernel: "6.8.12-tegra",
        },
        log: "passed\n",
      })),
    reset: options.reset ?? (async () => {}),
  };
}

function coordinator(stateDirectory: string, dispatchWorker: JetsonDispatchWorker) {
  return new JetsonDispatchCoordinator({
    stateDirectory,
    worker: dispatchWorker,
    executionTimeoutMs: 60_000,
    resetTimeoutMs: 10_000,
  });
}

describe("Jetson dispatch request and OIDC boundary", () => {
  it("accepts only the fixed target and exact workflow run identity (#8142)", () => {
    expect(REQUEST).toEqual({
      schemaVersion: 1,
      target: "jetson-nvmap-gpu",
      candidateSha: CANDIDATE_SHA,
      workflowRunId: "123456789",
      workflowRunAttempt: 1,
    });
  });

  it.each([
    "command",
    "host",
    "identityFile",
    "repository",
    "url",
  ])("rejects request-controlled %s fields (#8142)", (field) => {
    expect(() => parseJetsonDispatchRequest({ ...REQUEST, [field]: "unsafe" })).toThrow(
      "dispatch request fields must match the fixed Jetson contract",
    );
  });

  it("verifies the signature and all trusted GitHub controller claims (#8142)", async () => {
    const keys = signingKeys();
    const verified = await verifyGitHubOidcToken({
      token: signToken(keys.privateKey, claims()),
      request: REQUEST,
      policy: { repositoryId: REPOSITORY_ID },
      resolveSigningKey: async () => keys.publicKey,
      nowMs: NOW_SECONDS * 1_000,
    });

    expect(verified).toEqual(identity());
  });

  it("reuses each GitHub OIDC token for a bounded polling interval (#8142)", async () => {
    let nowMs = 1_000;
    const fetchImpl = vi.fn(async () => Response.json({ value: `token-${nowMs}` }));
    const token = createGitHubOidcTokenProvider({ fetchImpl, now: () => nowMs });
    const env = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/id-token",
    };

    await expect(token(env)).resolves.toBe("token-1000");
    nowMs += 60_000;
    await expect(token(env)).resolves.toBe("token-1000");
    nowMs += 4 * 60_000;
    await expect(token(env)).resolves.toBe("token-301000");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["issuer", { iss: "https://example.test" }],
    ["audience", { aud: "another-service" }],
    ["repository", { repository: "someone/NemoClaw" }],
    ["repository ID", { repository_id: "123" }],
    ["workflow", { workflow_ref: "NVIDIA/NemoClaw/.github/workflows/other.yaml@refs/heads/main" }],
    ["ref", { ref: "refs/heads/feature" }],
    ["event", { event_name: "pull_request" }],
    ["runner", { runner_environment: "self-hosted" }],
    ["run ID", { run_id: "999" }],
    ["run attempt", { run_attempt: "2" }],
    ["workflow SHA", { sha: "c".repeat(40) }],
  ])("rejects a mismatched %s claim (#8142)", async (_name, override) => {
    const keys = signingKeys();
    await expect(
      verifyGitHubOidcToken({
        token: signToken(keys.privateKey, claims(override)),
        request: REQUEST,
        policy: { repositoryId: REPOSITORY_ID },
        resolveSigningKey: async () => keys.publicKey,
        nowMs: NOW_SECONDS * 1_000,
      }),
    ).rejects.toThrow("OIDC claims do not match the trusted Jetson controller");
  });

  it("rejects expired and incorrectly signed controller tokens (#8142)", async () => {
    const trusted = signingKeys();
    const untrusted = signingKeys();
    await expect(
      verifyGitHubOidcToken({
        token: signToken(trusted.privateKey, claims({ exp: NOW_SECONDS - 60 })),
        request: REQUEST,
        policy: { repositoryId: REPOSITORY_ID },
        resolveSigningKey: async () => trusted.publicKey,
        nowMs: NOW_SECONDS * 1_000,
      }),
    ).rejects.toThrow("OIDC token is outside its allowed validity window");
    await expect(
      verifyGitHubOidcToken({
        token: signToken(untrusted.privateKey, claims()),
        request: REQUEST,
        policy: { repositoryId: REPOSITORY_ID },
        resolveSigningKey: async () => trusted.publicKey,
        nowMs: NOW_SECONDS * 1_000,
      }),
    ).rejects.toThrow("OIDC signature verification failed");
  });

  it("coalesces key-set loads and bounds unknown-key refreshes (#8142)", async () => {
    const keys = signingKeys();
    const jwk = keys.publicKey.export({ format: "jwk" });
    const fetchImpl = vi.fn(async () =>
      Response.json({ keys: [{ ...jwk, alg: "RS256", kid: "known", use: "sig" }] }),
    );
    const resolve = createGitHubJwksResolver(fetchImpl as typeof fetch);

    await Promise.all([
      expect(resolve("missing-1")).rejects.toThrow("OIDC signing key is unknown"),
      expect(resolve("missing-2")).rejects.toThrow("OIDC signing key is unknown"),
    ]);
    await expect(resolve("missing-3")).rejects.toThrow("OIDC signing key is unknown");
    await expect(resolve("known")).resolves.toMatchObject({ type: "public" });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("Jetson single-device lifecycle", () => {
  it("keeps the maximum log and archive response within the controller bound (#8142)", () => {
    const artifact = {
      artifactArchiveBase64: Buffer.alloc(MAX_JETSON_ARTIFACT_ARCHIVE_BYTES).toString("base64"),
      log: "\0".repeat(MAX_JETSON_DISPATCH_LOG_BYTES),
      status: {
        schemaVersion: 1,
        jobId: "d".repeat(64),
        request: REQUEST,
        state: "completed",
        conclusion: "success",
        createdAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        reset: "succeeded",
      },
    };

    expect(Buffer.byteLength(`${JSON.stringify(artifact)}\n`)).toBeLessThanOrEqual(
      MAX_JETSON_DISPATCH_ARTIFACT_RESPONSE_BYTES,
    );
  });

  it("records success only after reset succeeds (#8142)", async () => {
    const reset = vi.fn(async () => {});
    const dispatch = coordinator(temporaryDirectory(), worker({ reset }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({
      state: "completed",
      conclusion: "success",
      reset: "succeeded",
      device: { model: "NVIDIA Jetson AGX Thor Developer Kit" },
    });
    expect(reset).toHaveBeenCalledOnce();
    expect(dispatch.artifact(accepted.jobId)).toMatchObject({
      artifactArchiveBase64: ARTIFACT_ARCHIVE_BASE64,
      log: "passed\n",
    });
  });

  it("rejects a second job while the Jetson lock is held (#8142)", async () => {
    let finish: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          finish = () => reject(new Error("finished by test"));
        }),
    );
    const dispatch = coordinator(temporaryDirectory(), worker({ run }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const other = { ...REQUEST, candidateSha: "c".repeat(40) };
    expect(() => dispatch.dispatch(other, identity())).toThrow(JetsonDispatchBusyError);
    finish!();
    await waitForCompletion(dispatch, accepted.jobId);
  });

  it("cancels the worker and still resets the device (#8142)", async () => {
    const reset = vi.fn(async () => {});
    const run = vi.fn(
      (_request, options) =>
        new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const dispatch = coordinator(temporaryDirectory(), worker({ reset, run }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    dispatch.cancel(accepted.jobId);
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({ conclusion: "cancelled", reset: "succeeded" });
    expect(reset).toHaveBeenCalledOnce();
  });

  it("times out the worker and still resets the device (#8142)", async () => {
    vi.useFakeTimers();
    const reset = vi.fn(async () => {});
    const run = vi.fn(
      (_request, options) =>
        new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("timed out")), {
            once: true,
          });
        }),
    );
    const dispatch = coordinator(temporaryDirectory(), worker({ reset, run }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    await vi.advanceTimersByTimeAsync(60_000);
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({ conclusion: "timed-out", reset: "succeeded" });
    expect(reset).toHaveBeenCalledOnce();
  });

  it("keeps reset evidence accurate when lock removal fails (#8142)", async () => {
    const reset = vi.fn(async () => {});
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw new Error("lock filesystem unavailable");
    });
    const dispatch = coordinator(temporaryDirectory(), worker({ reset }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({
      conclusion: "reset-failed",
      error: "Jetson lock removal failed: lock filesystem unavailable",
      reset: "succeeded",
    });
  });

  it("bounds retained in-memory job status while preserving private evidence (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const dispatch = coordinator(stateDirectory, worker());
    await dispatch.initialize();
    let firstJobId = "";
    for (let index = 0; index < 129; index += 1) {
      const accepted = dispatch.dispatch(
        { ...REQUEST, candidateSha: index.toString(16).padStart(40, "0") },
        identity(),
      );
      firstJobId ||= accepted.jobId;
      await waitForCompletion(dispatch, accepted.jobId);
    }

    expect(() => dispatch.status(firstJobId)).toThrow(JetsonDispatchNotFoundError);
    expect(fs.existsSync(path.join(stateDirectory, `${firstJobId}.json`))).toBe(true);
  });

  it("keeps the device locked when reset fails (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const dispatch = coordinator(
      stateDirectory,
      worker({ reset: async () => Promise.reject(new Error("reset helper failed")) }),
    );
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({ conclusion: "reset-failed", reset: "failed" });
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);
    expect(() =>
      dispatch.dispatch({ ...REQUEST, candidateSha: "c".repeat(40) }, identity()),
    ).toThrow("Jetson device lock requires recovery");
    await expect(dispatch.shutdown()).rejects.toThrow(
      "Jetson device lock still requires reset recovery",
    );
  });

  it("resets a stale lock before accepting work after restart (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    fs.writeFileSync(path.join(stateDirectory, "device.lock"), "stale-job\n", { mode: 0o600 });
    const reset = vi.fn(async () => {});
    const dispatch = coordinator(stateDirectory, worker({ reset }));
    await dispatch.initialize();

    expect(reset).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(false);
  });
});

describe("Jetson dispatch HTTP boundary", () => {
  it("retries transient status failures and cancels after the bounded limit (#8142)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const jobId = "d".repeat(64);
    const initialStatus: JetsonDispatchStatus = {
      schemaVersion: 1,
      jobId,
      request: REQUEST,
      state: "queued",
      createdAt: new Date(0).toISOString(),
      reset: "pending",
    };
    const completed = {
      job: {
        ...initialStatus,
        state: "completed",
        conclusion: "success",
        reset: "succeeded",
      },
    };
    const recoveredRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("tunnel reset"))
      .mockRejectedValueOnce(new Error("tunnel reset"))
      .mockResolvedValueOnce(completed);

    await expect(
      pollJetsonDispatch({
        baseUrl: new URL("https://dispatch.test/"),
        deadlineMs: 10_000,
        initialStatus,
        jobId,
        now: () => 0,
        request: recoveredRequest,
        wait: async () => {},
      }),
    ).resolves.toMatchObject({ state: "completed" });

    const failedRequest = vi.fn().mockRejectedValue(new Error("tunnel unavailable"));
    await expect(
      pollJetsonDispatch({
        baseUrl: new URL("https://dispatch.test/"),
        deadlineMs: 10_000,
        initialStatus,
        jobId,
        now: () => 0,
        request: failedRequest,
        wait: async () => {},
      }),
    ).rejects.toThrow("tunnel unavailable");
    expect(failedRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "DELETE", path: `v1/jobs/${jobId}` }),
    );
  });

  it("denies anonymous requests and returns authenticated result evidence (#8142)", async () => {
    const keys = signingKeys();
    const now = Math.floor(Date.now() / 1_000);
    const token = signToken(
      keys.privateKey,
      claims({ exp: now + 9 * 60, iat: now - 60, nbf: now - 60 }),
    );
    const dispatch = coordinator(temporaryDirectory(), worker());
    await dispatch.initialize();
    const server = createJetsonDispatchServer({
      coordinator: dispatch,
      repositoryId: REPOSITORY_ID,
      resolveSigningKey: async () => keys.publicKey,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/jobs`;
    try {
      const anonymous = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST),
      });
      expect(anonymous.status).toBe(401);

      const injected = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...REQUEST, command: "uname -a" }),
      });
      expect(injected.status).toBe(400);

      const accepted = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(REQUEST),
      });
      expect(accepted.status).toBe(202);
      const acceptedBody = (await accepted.json()) as { job: { jobId: string } };
      await waitForCompletion(dispatch, acceptedBody.job.jobId);

      const anonymousExisting = await fetch(`${url}/${acceptedBody.job.jobId}`);
      const anonymousUnknown = await fetch(`${url}/${"f".repeat(64)}`);
      const authenticatedUnknown = await fetch(`${url}/${"f".repeat(64)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect([
        anonymousExisting.status,
        anonymousUnknown.status,
        authenticatedUnknown.status,
      ]).toEqual([401, 401, 401]);

      const artifact = await fetch(`${url}/${acceptedBody.job.jobId}/artifact`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(artifact.status).toBe(200);
      await expect(artifact.json()).resolves.toMatchObject({
        log: "passed\n",
        status: { conclusion: "success", reset: "succeeded" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
