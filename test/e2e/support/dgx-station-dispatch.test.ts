// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dgxSparkDispatchRequestFromEnvironment } from "../../../tools/e2e/dgx-spark-dispatch-client.mts";
import { dgxStationDispatchRequestFromEnvironment } from "../../../tools/e2e/dgx-station-dispatch-client.mts";
import {
  createGitHubOidcTokenProvider,
  dispatcherBaseUrl,
  pollJetsonDispatch,
  dispatcherRequest,
  runDispatchClient,
  printableDispatchError,
  submitJetsonDispatch,
} from "../../../tools/e2e/jetson-dispatch-client.mts";
import {
  DGX_STATION_DISPATCH_AUDIENCE,
  DGX_SPARK_DISPATCH_TARGET,
  DGX_SPARK_DISPATCH_AUDIENCE,
  parseDgxSparkDispatchRequest,
  dispatchJobId,
  parseDgxStationDispatchRequest,
  parseDispatchArtifact,
  parseDispatchStatus,
  parseDispatchStatusResponse,
  parseJetsonDispatchArtifact,
  parseJetsonDispatchRequest,
  parseJetsonDispatchStatus,
} from "../../../tools/e2e/jetson-dispatch-contract.mts";

const vectorBytes = fs.readFileSync(
  path.join(process.cwd(), "tools/e2e/contracts/v3/dgx-station-dispatch.json"),
);
const vectors = JSON.parse(vectorBytes.toString("utf8"));
const request = parseDgxStationDispatchRequest(vectors.request);
const queued = parseDispatchStatusResponse(vectors.queuedResponse, request);
const directories: string[] = [];
function artifactDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "station-dispatch-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("Station dispatch contract and controller", () => {
  it("matches the pinned backend v3 compatibility bytes", () => {
    expect(createHash("sha256").update(vectorBytes).digest("hex")).toBe(
      "61c566d20543812a8d55bbc130252c30786023ce521f459ef736190883d4aa85",
    );
    expect(request).toEqual(vectors.request);
    expect(queued).toEqual(vectors.queuedResponse.job);
    expect(parseDispatchStatus(vectors.completedStatus)).toEqual(vectors.completedStatus);
    expect(parseDispatchArtifact(vectors.artifact, queued.jobId)).toEqual(vectors.artifact);
  });

  it.each(vectors.invalidRequests as { name: string; value: unknown }[])(
    "rejects $name",
    ({ value }) => {
      expect(() => parseDgxStationDispatchRequest(value)).toThrow();
    },
  );

  it("keeps Station evidence outside the Jetson-only parsers", () => {
    expect(() => parseJetsonDispatchRequest(vectors.request)).toThrow();
    expect(() => parseJetsonDispatchStatus(vectors.completedStatus)).toThrow();
    expect(() => parseJetsonDispatchArtifact(vectors.artifact, queued.jobId)).toThrow();
  });

  it("binds candidate and managed-image revisions independently into the job identity", () => {
    expect(dispatchJobId(request)).toBe(queued.jobId);
    expect(dispatchJobId({ ...request, candidateSha: "c".repeat(40) })).not.toBe(queued.jobId);
    expect(dispatchJobId({ ...request, managedImageRevision: "c".repeat(40) })).not.toBe(
      queued.jobId,
    );
  });

  it("constructs Station requests without reading the Jetson candidate settings", () => {
    expect(
      dgxStationDispatchRequestFromEnvironment({
        DGX_STATION_DISPATCH_CANDIDATE_SHA: request.candidateSha,
        DGX_STATION_DISPATCH_MANAGED_IMAGE_REVISION: request.managedImageRevision,
        JETSON_DISPATCH_CANDIDATE_SHA: "c".repeat(40),
        JETSON_DISPATCH_MANAGED_IMAGE_REVISION: "d".repeat(40),
        GITHUB_RUN_ID: request.workflowRunId,
        GITHUB_RUN_ATTEMPT: String(request.workflowRunAttempt),
      }),
    ).toEqual(request);
    expect(() =>
      dgxStationDispatchRequestFromEnvironment({
        JETSON_DISPATCH_CANDIDATE_SHA: request.candidateSha,
      }),
    ).toThrow();
    expect(() => dispatcherBaseUrl(undefined, "DGX_STATION_DISPATCH_URL")).toThrow(
      "DGX_STATION_DISPATCH_URL is required",
    );
  });

  it("requests and caches tokens for the Station audience", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ value: "station-token" }));
    const provider = createGitHubOidcTokenProvider({
      fetchImpl,
      audience: DGX_STATION_DISPATCH_AUDIENCE,
    });
    const environment = {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    };
    expect(await provider(environment)).toBe("station-token");
    expect(await provider(environment)).toBe("station-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "audience=nemoclaw-dgx-station-dispatch",
    );
  });

  it("writes the recovery receipt before submission and cancels an unknown outcome", async () => {
    const receiptFile = path.join(artifactDirectory(), "station.json");
    const transport = vi
      .fn<typeof dispatcherRequest>()
      .mockImplementationOnce(async () => {
        expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toMatchObject({
          jobId: queued.jobId,
          request,
        });
        throw new Error("connection lost");
      })
      .mockResolvedValueOnce({ job: queued });
    await expect(
      submitJetsonDispatch({
        baseUrl: new URL("https://example.test"),
        dispatchRequest: request,
        receiptFile,
        request: transport,
      }),
    ).rejects.toThrow("submission outcome was not confirmed");
    expect(transport.mock.calls.map(([options]) => options.method)).toEqual(["POST", "DELETE"]);
  });

  it("cancels the same Station job when its controller deadline expires", async () => {
    const receiptFile = path.join(artifactDirectory(), "station.json");
    const transport = vi.fn(async () => ({ job: queued }));
    await expect(
      pollJetsonDispatch({
        baseUrl: new URL("https://example.test"),
        initialStatus: queued,
        deadlineMs: 1,
        now: () => 2,
        receiptFile,
        request: transport,
      }),
    ).rejects.toThrow("controller deadline");
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: `v1/jobs/${queued.jobId}` }),
    );
  });

  it("requires Station device identity and rejects terminal controls in human-readable identity", () => {
    expect(() => parseDispatchStatus({ ...vectors.completedStatus, device: undefined })).toThrow(
      "device identity",
    );
    expect(() =>
      parseDispatchStatus({
        ...vectors.completedStatus,
        device: { ...vectors.completedStatus.device, model: "Station\u001b[2J" },
      }),
    ).toThrow("Station device model is invalid");
    expect(() =>
      parseDispatchStatus({
        ...vectors.completedStatus,
        device: { ...vectors.completedStatus.device, osRelease: "Ubuntu\u009b2J" },
      }),
    ).toThrow("Station device osRelease is invalid");
  });

  it("saves Station artifacts and removes its cancellation listeners after completion", async () => {
    const directory = artifactDirectory();
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const transport = vi.fn(async (options: Parameters<typeof dispatcherRequest>[0]) =>
      options.path.endsWith("/artifact") ? vectors.artifact : { job: vectors.completedStatus },
    );
    await runDispatchClient({
      request,
      baseUrl: new URL("https://example.test"),
      artifactDirectory: directory,
      receiptName: "station.json",
      archiveName: "station.tar.gz",
      requestImpl: transport,
    });
    expect(fs.readFileSync(path.join(directory, "station.tar.gz"))).toEqual(
      Buffer.from(vectors.artifact.artifactArchiveBase64, "base64"),
    );
    expect(JSON.parse(fs.readFileSync(path.join(directory, "station.json"), "utf8"))).toMatchObject(
      { status: { request, conclusion: "success" } },
    );
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});

it("removes terminal controls from a dispatcher error before printing it", () => {
  expect(printableDispatchError(new Error("remote\u001b[2J\u009b31m\nmessage"))).toBe(
    "remote [2J 31m message",
  );
  expect(printableDispatchError(new Error("x".repeat(2000)))).toHaveLength(1000);
});

describe("Spark candidate-bound dispatch evidence", () => {
  const sparkVectors = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "tools/e2e/contracts/v4/dgx-spark-dispatch.json"),
      "utf8",
    ),
  );

  it("accepts the Spark backend compatibility vector and rejects its malformed requests", () => {
    expect(parseDgxSparkDispatchRequest(sparkVectors.request)).toEqual(sparkVectors.request);
    expect(parseDispatchStatus(sparkVectors.completedStatus)).toEqual(sparkVectors.completedStatus);
    expect(
      parseDispatchArtifact(sparkVectors.artifact, sparkVectors.completedStatus.jobId),
    ).toEqual(sparkVectors.artifact);
  });

  it.each(sparkVectors.invalidRequests as { name: string; value: unknown }[])(
    "rejects the Spark backend request with $name",
    ({ value }) => {
      expect(() => parseDgxSparkDispatchRequest(value)).toThrow();
    },
  );

  it("requests a Spark OIDC token without using Station's audience", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ value: "spark-token" }));
    const provider = createGitHubOidcTokenProvider({
      fetchImpl,
      audience: DGX_SPARK_DISPATCH_AUDIENCE,
    });
    expect(
      await provider({
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      }),
    ).toBe("spark-token");
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("audience")).toBe(
      "nemoclaw-dgx-spark-dispatch",
    );
  });

  it("fails a Spark success that omits its evidence archive", async () => {
    const directory = artifactDirectory();
    const transport = vi.fn(async (options: Parameters<typeof dispatcherRequest>[0]) =>
      options.path.endsWith("/artifact")
        ? { status: sparkVectors.completedStatus, log: "fixture" }
        : { job: sparkVectors.completedStatus },
    );
    await expect(
      runDispatchClient({
        request: parseDgxSparkDispatchRequest(sparkVectors.request),
        baseUrl: new URL("https://example.test"),
        artifactDirectory: directory,
        receiptName: "spark.json",
        archiveName: "spark.tar.gz",
        requestImpl: transport,
      }),
    ).rejects.toThrow("include its artifact archive");
    expect(JSON.parse(fs.readFileSync(path.join(directory, "spark.json"), "utf8")).request).toEqual(
      sparkVectors.request,
    );
  });
  const sparkRequest = {
    ...request,
    schemaVersion: 4,
    target: DGX_SPARK_DISPATCH_TARGET,
  } as const;

  it("keeps Spark and Station requests distinct and binds both revisions", () => {
    expect(parseDgxSparkDispatchRequest(sparkRequest)).toEqual(sparkRequest);
    expect(() => parseDgxStationDispatchRequest(sparkRequest)).toThrow();
    expect(() => parseDgxSparkDispatchRequest(request)).toThrow();
    expect(dispatchJobId(sparkRequest)).not.toBe(dispatchJobId(request));
    expect(dispatchJobId({ ...sparkRequest, candidateSha: "c".repeat(40) })).not.toBe(
      dispatchJobId(sparkRequest),
    );
    expect(dispatchJobId({ ...sparkRequest, managedImageRevision: "c".repeat(40) })).not.toBe(
      dispatchJobId(sparkRequest),
    );
  });

  it("requires Spark settings and cannot read Station settings as a fallback", () => {
    expect(
      dgxSparkDispatchRequestFromEnvironment({
        DGX_SPARK_DISPATCH_CANDIDATE_SHA: request.candidateSha,
        DGX_SPARK_DISPATCH_MANAGED_IMAGE_REVISION: request.managedImageRevision,
        GITHUB_RUN_ID: request.workflowRunId,
        GITHUB_RUN_ATTEMPT: String(request.workflowRunAttempt),
      }),
    ).toEqual(sparkRequest);
    expect(() =>
      dgxSparkDispatchRequestFromEnvironment({
        DGX_STATION_DISPATCH_CANDIDATE_SHA: request.candidateSha,
        DGX_STATION_DISPATCH_MANAGED_IMAGE_REVISION: request.managedImageRevision,
      }),
    ).toThrow();
  });

  it("retains Spark's candidate, device, and cleanup receipt with the returned archive", async () => {
    const directory = artifactDirectory();
    const status = {
      ...vectors.completedStatus,
      schemaVersion: 4,
      request: sparkRequest,
      jobId: dispatchJobId(sparkRequest),
      device: { ...vectors.completedStatus.device, model: "NVIDIA DGX Spark GB10 fixture" },
    };
    const artifact = { ...vectors.artifact, status };
    const transport = vi.fn(async (options: Parameters<typeof dispatcherRequest>[0]) =>
      options.path.endsWith("/artifact") ? artifact : { job: status },
    );
    await runDispatchClient({
      request: sparkRequest,
      baseUrl: new URL("https://example.test"),
      artifactDirectory: directory,
      receiptName: "dgx-spark-dispatch.json",
      archiveName: "dgx-spark-e2e-artifacts.tar.gz",
      requestImpl: transport,
    });
    const saved = JSON.parse(
      fs.readFileSync(path.join(directory, "dgx-spark-dispatch.json"), "utf8"),
    );
    expect(saved.status).toEqual(status);
    expect(fs.readFileSync(path.join(directory, "dgx-spark-e2e-artifacts.tar.gz"))).toEqual(
      Buffer.from(artifact.artifactArchiveBase64, "base64"),
    );
    expect(() =>
      parseDispatchStatusResponse({ job: vectors.completedStatus }, sparkRequest),
    ).toThrow();
    expect(() => parseDispatchArtifact(artifact, dispatchJobId(request))).toThrow();
    expect(() => parseDispatchStatus({ ...status, cleanup: "pending" })).toThrow();
  });
});
