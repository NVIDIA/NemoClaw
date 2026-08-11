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
  type JetsonDispatchStatus,
  type JetsonDispatchWorker,
  MAX_JETSON_ARTIFACT_ARCHIVE_BYTES,
  MAX_JETSON_DISPATCH_ARTIFACT_RESPONSE_BYTES,
  MAX_JETSON_DISPATCH_LOG_BYTES,
} from "../../../tools/e2e/jetson-dispatch-lifecycle.mts";
import { createJetsonDispatchServer } from "../../../tools/e2e/jetson-dispatch-service.mts";
import { testTimeoutOptions } from "../../helpers/timeouts.ts";

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

function failTest(message: string): never {
  throw new Error(message);
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
  options: { cleanup?: JetsonDispatchWorker["cleanup"]; run?: JetsonDispatchWorker["run"] } = {},
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
    cleanup: options.cleanup ?? (async () => {}),
  };
}

function coordinator(stateDirectory: string, dispatchWorker: JetsonDispatchWorker) {
  return new JetsonDispatchCoordinator({
    stateDirectory,
    worker: dispatchWorker,
    executionTimeoutMs: 60_000,
    cleanupTimeoutMs: 10_000,
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
        cleanup: "succeeded",
      },
    };

    expect(Buffer.byteLength(`${JSON.stringify(artifact)}\n`)).toBeLessThanOrEqual(
      MAX_JETSON_DISPATCH_ARTIFACT_RESPONSE_BYTES,
    );
  });

  it("records success only after cleanup succeeds (#8142)", async () => {
    const cleanup = vi.fn(async () => {});
    const dispatch = coordinator(temporaryDirectory(), worker({ cleanup }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({
      state: "completed",
      conclusion: "success",
      cleanup: "succeeded",
      device: { model: "NVIDIA Jetson AGX Thor Developer Kit" },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(dispatch.artifact(accepted.jobId)).toMatchObject({
      artifactArchiveBase64: ARTIFACT_ARCHIVE_BASE64,
      log: "passed\n",
    });
  });

  it("records test failure after cleanup succeeds (#8142)", async () => {
    const cleanup = vi.fn(async () => {});
    const dispatch = coordinator(
      temporaryDirectory(),
      worker({ cleanup, run: async () => Promise.reject(new Error("test failed")) }),
    );
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({
      cleanup: "succeeded",
      conclusion: "failure",
      error: "test failed",
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("returns completed evidence when its result log is missing (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const dispatch = coordinator(stateDirectory, worker());
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    await waitForCompletion(dispatch, accepted.jobId);
    fs.rmSync(path.join(stateDirectory, `${accepted.jobId}.log`));

    expect(dispatch.artifact(accepted.jobId)).toMatchObject({
      artifactArchiveBase64: ARTIFACT_ARCHIVE_BASE64,
      log: "",
      status: { conclusion: "success", state: "completed" },
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

  it("persists the lock and queued status before worker execution (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const events: string[] = [];
    const fsyncSync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      events.push(fs.fstatSync(descriptor).isDirectory() ? "directory-fsync" : "file-fsync");
      fsyncSync(descriptor);
    });
    const unlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      events.push(file === path.join(stateDirectory, "device.lock") ? "lock-unlink" : "unlink");
      unlinkSync(file);
    });
    const run = vi.fn(async (_request, options) => {
      events.push("worker-run");
      expect(fs.readFileSync(path.join(stateDirectory, "device.lock"), "utf8")).toBe(
        `${options.jobId}\n`,
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(stateDirectory, `${options.jobId}.json`), "utf8")),
      ).toMatchObject({ jobId: options.jobId, state: "queued" });
      return worker().run(_request, options);
    });
    const dispatch = coordinator(stateDirectory, worker({ run }));
    await dispatch.initialize();

    const accepted = dispatch.dispatch(REQUEST, identity());
    await waitForCompletion(dispatch, accepted.jobId);

    expect(events.indexOf("directory-fsync")).toBeLessThan(events.indexOf("worker-run"));
    expect(events.indexOf("worker-run")).toBeLessThan(events.indexOf("lock-unlink"));
    expect(events.indexOf("lock-unlink")).toBeLessThan(events.lastIndexOf("directory-fsync"));
  });

  it("does not start the worker when state directory persistence fails (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const fsyncSync = fs.fsyncSync.bind(fs);
    let rejectDirectoryFsync = true;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      const isDirectory = fs.fstatSync(descriptor).isDirectory();
      const shouldReject = rejectDirectoryFsync && isDirectory;
      rejectDirectoryFsync = rejectDirectoryFsync && !isDirectory;
      return shouldReject ? failTest("state directory persistence failed") : fsyncSync(descriptor);
    });
    const run = vi.fn(worker().run);
    const cleanup = vi.fn(async () => {});
    const dispatch = coordinator(stateDirectory, worker({ cleanup, run }));
    await dispatch.initialize();

    expect(() => dispatch.dispatch(REQUEST, identity())).toThrow(
      "state directory persistence failed",
    );

    expect(run).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);

    const restarted = coordinator(stateDirectory, worker({ cleanup, run }));
    await restarted.initialize();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(false);
  });

  it("cancels the worker and still cleans the device with a fresh signal (#8142)", async () => {
    let runSignal: AbortSignal | undefined;
    let cleanupSignal: AbortSignal | undefined;
    const cleanup = vi.fn(async (options: { jobId: string; signal: AbortSignal }) => {
      cleanupSignal = options.signal;
    });
    const run = vi.fn(
      (_request, options) =>
        new Promise<never>((_resolve, reject) => {
          runSignal = options.signal;
          options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const dispatch = coordinator(temporaryDirectory(), worker({ cleanup, run }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    dispatch.cancel(accepted.jobId);
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({ cleanup: "succeeded", conclusion: "cancelled" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupSignal).not.toBe(runSignal);
    expect(cleanupSignal?.aborted).toBe(false);
  });

  it("times out the worker and still cleans the device (#8142)", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => {});
    const run = vi.fn(
      (_request, options) =>
        new Promise<never>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("timed out")), {
            once: true,
          });
        }),
    );
    const dispatch = coordinator(temporaryDirectory(), worker({ cleanup, run }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    await vi.advanceTimersByTimeAsync(60_000);
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({ cleanup: "succeeded", conclusion: "timed-out" });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("keeps cleanup evidence accurate when lock removal fails (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const cleanup = vi.fn(async () => {});
    const unlinkSync = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync")
      .mockImplementationOnce(() => {
        throw new Error("lock filesystem unavailable");
      })
      .mockImplementation(unlinkSync);
    const dispatch = coordinator(stateDirectory, worker({ cleanup }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({
      conclusion: "cleanup-failed",
      error: "Jetson lock removal failed: lock filesystem unavailable",
      cleanup: "succeeded",
    });
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);

    const restarted = coordinator(stateDirectory, worker({ cleanup }));
    await restarted.initialize();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(false);
  });

  it("restores the device lock when directory fsync fails after removal (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const cleanup = vi.fn(async () => {});
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directorySyncCount = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      const isDirectory = fs.fstatSync(descriptor).isDirectory();
      directorySyncCount += Number(isDirectory);
      return isDirectory && directorySyncCount === 2
        ? failTest("lock directory persistence failed")
        : fsyncSync(descriptor);
    });
    const dispatch = coordinator(stateDirectory, worker({ cleanup }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({
      conclusion: "cleanup-failed",
      error: "Jetson lock removal failed: lock directory persistence failed",
      cleanup: "succeeded",
    });
    expect(directorySyncCount).toBe(3);
    expect(fs.readFileSync(path.join(stateDirectory, "device.lock"), "utf8")).toBe(
      `${accepted.jobId}\n`,
    );

    const restarted = coordinator(stateDirectory, worker({ cleanup }));
    await restarted.initialize();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(false);
  });

  it("blocks later dispatch when lock restoration cannot recreate the lock (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const lockPath = path.join(stateDirectory, "device.lock");
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directorySyncCount = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      const isDirectory = fs.fstatSync(descriptor).isDirectory();
      directorySyncCount += Number(isDirectory);
      return isDirectory && directorySyncCount === 2
        ? failTest("lock directory persistence failed")
        : fsyncSync(descriptor);
    });
    const run = vi.fn(worker().run);
    const dispatch = coordinator(stateDirectory, worker({ run }));
    await dispatch.initialize();
    const openSync = fs.openSync.bind(fs);
    let lockOpenCount = 0;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const isLock = file === lockPath;
      lockOpenCount += Number(isLock);
      return isLock && lockOpenCount === 2
        ? failTest("lock restoration unavailable")
        : openSync(file, flags, mode);
    });
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed.error).toContain("lock restoration failed: lock restoration unavailable");
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(() =>
      dispatch.dispatch({ ...REQUEST, candidateSha: "c".repeat(40) }, identity()),
    ).toThrow("Jetson device lock requires recovery");
    expect(run).toHaveBeenCalledOnce();
    await expect(dispatch.shutdown()).rejects.toThrow(
      "Jetson device lock state requires operator recovery",
    );
  });

  it("keeps the lock until restart persists a terminal result (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const expectedResult = await worker().run(REQUEST, {
      jobId: "e".repeat(64),
      signal: new AbortController().signal,
    });
    let finishRun!: () => void;
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return expectedResult;
    });
    const first = coordinator(stateDirectory, worker({ run }));
    await first.initialize();
    const accepted = first.dispatch(REQUEST, identity());
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const statusPath = path.join(stateDirectory, `${accepted.jobId}.json`);
    const runningStatus = fs.readFileSync(statusPath, "utf8");
    fs.rmSync(statusPath);
    fs.mkdirSync(statusPath);

    finishRun();
    const failedPersistence = await waitForCompletion(first, accepted.jobId);

    expect(failedPersistence).toMatchObject({
      cleanup: "succeeded",
      conclusion: "failure",
      error: expect.stringContaining("Final status persistence failed"),
    });
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);

    const recoveryCleanup = vi.fn(async () => {});
    await expect(
      coordinator(stateDirectory, worker({ cleanup: recoveryCleanup })).initialize(),
    ).rejects.toThrow(`Jetson dispatch status ${accepted.jobId}.json is invalid`);
    expect(recoveryCleanup).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);

    fs.rmSync(statusPath, { recursive: true });
    fs.writeFileSync(statusPath, runningStatus, { mode: 0o600 });
    const replayRun = vi.fn(worker().run);
    const restarted = coordinator(
      stateDirectory,
      worker({ cleanup: recoveryCleanup, run: replayRun }),
    );
    await restarted.initialize();

    expect(restarted.status(accepted.jobId)).toMatchObject({
      cleanup: "succeeded",
      conclusion: "failure",
      error: "Jetson dispatcher restarted before terminal status was persisted",
      state: "completed",
    });
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(false);
    expect(recoveryCleanup).toHaveBeenCalledTimes(2);
    expect(restarted.dispatch(REQUEST, identity()).state).toBe("completed");
    expect(replayRun).not.toHaveBeenCalled();
  });

  it("restores completed evidence without replaying the job after restart (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const first = coordinator(stateDirectory, worker());
    await first.initialize();
    const firstAccepted = first.dispatch(REQUEST, identity());
    const firstCompleted = await waitForCompletion(first, firstAccepted.jobId);
    expect(first.artifact(firstAccepted.jobId).artifactArchiveBase64).toBe(ARTIFACT_ARCHIVE_BASE64);

    const replayRun = vi.fn(worker().run);
    const restarted = coordinator(stateDirectory, worker({ run: replayRun }));
    await restarted.initialize();
    const restoredStatus = restarted.status(firstAccepted.jobId);
    const restoredArtifact = restarted.artifact(firstAccepted.jobId);
    const replayAccepted = restarted.dispatch(REQUEST, identity());

    expect(replayAccepted.jobId).toBe(firstAccepted.jobId);
    expect(replayAccepted).toEqual(firstCompleted);
    expect(restoredStatus).toEqual(firstCompleted);
    expect(restoredArtifact).toMatchObject({
      artifactArchiveBase64: ARTIFACT_ARCHIVE_BASE64,
      log: "passed\n",
      status: firstCompleted,
    });
    expect(replayRun).not.toHaveBeenCalled();
  });

  it("rejects initialization when a completed status record is invalid (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const first = coordinator(stateDirectory, worker());
    await first.initialize();
    const accepted = first.dispatch(REQUEST, identity());
    await waitForCompletion(first, accepted.jobId);
    const statusPath = path.join(stateDirectory, `${accepted.jobId}.json`);
    const persisted = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const invalidRecords = [
      {
        contents: `${JSON.stringify({ ...persisted, jobId: "f".repeat(64) })}\n`,
        error: "persisted Jetson dispatch status does not match its job ID",
      },
      { contents: "{", error: "persisted Jetson dispatch status is not valid JSON" },
      { contents: " ".repeat(16 * 1024 + 1), error: "exceeds 16384 bytes" },
    ];

    for (const record of invalidRecords) {
      fs.writeFileSync(statusPath, record.contents);
      await expect(coordinator(stateDirectory, worker()).initialize()).rejects.toThrow(
        new RegExp(`Jetson dispatch status ${accepted.jobId}\\.json is invalid: .*${record.error}`),
      );
    }
  });

  it(
    "restores private completed status after in-memory eviction (#8142)",
    testTimeoutOptions(10_000),
    async () => {
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

      expect(dispatch.status(firstJobId)).toMatchObject({ state: "completed" });
      expect(fs.existsSync(path.join(stateDirectory, `${firstJobId}.json`))).toBe(true);
      fs.writeFileSync(path.join(stateDirectory, `${firstJobId}.json`), "{");
      await expect(coordinator(stateDirectory, worker()).initialize()).rejects.toThrow(
        `Jetson dispatch status ${firstJobId}.json is invalid`,
      );
    },
  );

  it("keeps the device locked when cleanup loses a pre-existing Ollama model (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const dispatch = coordinator(
      stateDirectory,
      worker({
        cleanup: async () =>
          Promise.reject(
            new Error("Jetson cleanup did not preserve every pre-existing Ollama model"),
          ),
      }),
    );
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({ cleanup: "failed", conclusion: "cleanup-failed" });
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);
    expect(() =>
      dispatch.dispatch({ ...REQUEST, candidateSha: "c".repeat(40) }, identity()),
    ).toThrow("Jetson device lock requires recovery");
    await expect(dispatch.shutdown()).rejects.toThrow(
      "Jetson device lock still requires cleanup recovery",
    );
  });

  it("reports both candidate and cleanup failures while retaining the lock (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const dispatch = coordinator(
      stateDirectory,
      worker({
        cleanup: async () => Promise.reject(new Error("cleanup verification failed")),
        run: async () => Promise.reject(new Error("artifact collection failed")),
      }),
    );
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed).toMatchObject({
      cleanup: "failed",
      conclusion: "cleanup-failed",
      error: "artifact collection failed; Jetson cleanup failed: cleanup verification failed",
    });
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);
  });

  it("keeps a cleanup failure visible after a 500-character execution error (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const dispatch = coordinator(
      stateDirectory,
      worker({
        cleanup: async () => Promise.reject(new Error("cleanup verification failed")),
        run: async () => Promise.reject(new Error("x".repeat(500))),
      }),
    );
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed.error).toContain("Jetson cleanup failed: cleanup verification failed");
    expect(completed.error).toHaveLength(500);
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);
  });

  it("keeps a final persistence failure visible after a 500-character execution error (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    let rejectRun!: (error: Error) => void;
    const run = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectRun = reject;
        }),
    );
    const dispatch = coordinator(stateDirectory, worker({ run }));
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const statusPath = path.join(stateDirectory, `${accepted.jobId}.json`);
    fs.rmSync(statusPath);
    fs.mkdirSync(statusPath);
    rejectRun(new Error("x".repeat(500)));
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed.error).toContain("Final status persistence failed:");
    expect(completed.error).toHaveLength(500);
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);
  });

  it("keeps a lock-removal failure visible after a 500-character execution error (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
      throw new Error("lock filesystem unavailable");
    });
    const dispatch = coordinator(
      stateDirectory,
      worker({ run: async () => Promise.reject(new Error("x".repeat(500))) }),
    );
    await dispatch.initialize();
    const accepted = dispatch.dispatch(REQUEST, identity());
    const completed = await waitForCompletion(dispatch, accepted.jobId);

    expect(completed.error).toContain("Jetson lock removal failed: lock filesystem unavailable");
    expect(completed.error).toHaveLength(500);
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);
  });

  it("cleans a stale lock before accepting work after restart (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    const staleJobId = "d".repeat(64);
    fs.writeFileSync(path.join(stateDirectory, "device.lock"), `${staleJobId}\n`, { mode: 0o600 });
    const cleanup = vi.fn(async () => {});
    const dispatch = coordinator(stateDirectory, worker({ cleanup }));
    await dispatch.initialize();

    expect(cleanup).toHaveBeenCalledWith({ jobId: staleJobId, signal: expect.any(AbortSignal) });
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(false);
  });

  it("rejects a stale lock that cannot identify one dispatcher job (#8142)", async () => {
    const stateDirectory = temporaryDirectory();
    fs.writeFileSync(path.join(stateDirectory, "device.lock"), "../../arbitrary-path\n", {
      mode: 0o600,
    });
    const cleanup = vi.fn(async () => {});
    const dispatch = coordinator(stateDirectory, worker({ cleanup }));

    await expect(dispatch.initialize()).rejects.toThrow(
      "Jetson device lock contains an invalid job ID",
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);
  });

  it.each([
    `${"d".repeat(64)}\nextra\n`,
    `${"d".repeat(64)}\n\n`,
  ])("rejects trailing data in a stale device lock (#8142)", async (lockContents) => {
    const stateDirectory = temporaryDirectory();
    fs.writeFileSync(path.join(stateDirectory, "device.lock"), lockContents, { mode: 0o600 });
    const cleanup = vi.fn(async () => {});
    const dispatch = coordinator(stateDirectory, worker({ cleanup }));

    await expect(dispatch.initialize()).rejects.toThrow(
      "Jetson device lock contains an invalid job ID",
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDirectory, "device.lock"))).toBe(true);
  });
});

describe("Jetson dispatch HTTP boundary", () => {
  it("reports the controller deadline when cancellation also fails (#8142)", async () => {
    const jobId = "d".repeat(64);
    const request = vi.fn().mockRejectedValue(new Error("tunnel unavailable"));

    await expect(
      pollJetsonDispatch({
        baseUrl: new URL("https://dispatch.test/"),
        deadlineMs: 10_000,
        initialStatus: {
          schemaVersion: 1,
          jobId,
          request: REQUEST,
          state: "queued",
          createdAt: new Date(0).toISOString(),
          cleanup: "pending",
        },
        jobId,
        now: () => 10_000,
        request,
        wait: async () => {},
      }),
    ).rejects.toThrow("Jetson dispatcher did not complete before the controller deadline");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: `v1/jobs/${jobId}` }),
    );
  });

  it("retries transient status failures and cancels after the bounded limit (#8142)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const jobId = "d".repeat(64);
    const initialStatus: JetsonDispatchStatus = {
      schemaVersion: 1,
      jobId,
      request: REQUEST,
      state: "queued",
      createdAt: new Date(0).toISOString(),
      cleanup: "pending",
    };
    const completed = {
      job: {
        ...initialStatus,
        state: "completed",
        conclusion: "success",
        cleanup: "succeeded",
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
        status: { cleanup: "succeeded", conclusion: "success" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
