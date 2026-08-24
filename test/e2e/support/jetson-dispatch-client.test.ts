// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubOidcTokenProvider,
  dispatcherBaseUrl,
  dispatcherRequest,
  jetsonDispatchRequestFromEnvironment,
  pollJetsonDispatch,
} from "../../../tools/e2e/jetson-dispatch-client.mts";
import {
  JETSON_DISPATCH_AUDIENCE,
  JETSON_DISPATCH_CONTRACT_VERSION,
  JETSON_DISPATCH_V1_SHA256,
  JETSON_DISPATCH_V2_SHA256,
  type JetsonDispatchArtifact,
  type JetsonDispatchRequest,
  type JetsonDispatchStatus,
  parseJetsonDispatchArtifact,
  parseJetsonDispatchRequest,
  parseJetsonDispatchStatus,
  parseJetsonDispatchStatusResponse,
} from "../../../tools/e2e/jetson-dispatch-contract.mts";

interface CompatibilityVectors {
  artifact: unknown;
  completedStatus: unknown;
  contractVersion: string;
  invalidRequests: Array<{ name: string; value: unknown }>;
  request: unknown;
  queuedResponse: unknown;
}

const vectorBytes = fs.readFileSync(
  path.join(process.cwd(), "tools/e2e/contracts/v1/jetson-dispatch.json"),
);
const vectors = JSON.parse(vectorBytes.toString("utf8")) as CompatibilityVectors;
const vectorV2Bytes = fs.readFileSync(
  path.join(process.cwd(), "tools/e2e/contracts/v2/jetson-dispatch.json"),
);
const vectorsV2 = JSON.parse(vectorV2Bytes.toString("utf8")) as CompatibilityVectors;
const request = parseJetsonDispatchRequest(vectors.request);
const requestV2 = parseJetsonDispatchRequest(vectorsV2.request);
const queuedStatus = parseJetsonDispatchStatusResponse(vectors.queuedResponse);
const queuedStatusV2 = parseJetsonDispatchStatusResponse(vectorsV2.queuedResponse);
const completedStatus = parseJetsonDispatchStatus(vectors.completedStatus);
const completedStatusV2 = parseJetsonDispatchStatus(vectorsV2.completedStatus);
const invalidRequestErrors: Record<string, string> = {
  "extra request field": "dispatch request fields do not match Jetson dispatch contract 1.0.0",
  "noncanonical candidate SHA": "candidateSha must be a lowercase 40-character commit SHA",
  "wrong target": "dispatch target must be jetson-nvmap-gpu",
};
const invalidV2RequestErrors: Record<string, string> = {
  "extra request field": "dispatch request fields do not match Jetson dispatch contract 2.0.0",
  "missing managed-image revision":
    "dispatch request fields do not match Jetson dispatch contract 2.0.0",
  "noncanonical managed-image revision":
    "managedImageRevision must be a lowercase 40-character commit SHA",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Jetson dispatch static HTTP contract", () => {
  it("keeps the published v1 bytes immutable (#8142)", () => {
    expect(createHash("sha256").update(vectorBytes).digest("hex")).toBe(JETSON_DISPATCH_V1_SHA256);
  });

  it("accepts every version 1.0.0 compatibility vector (#8142)", () => {
    expect(vectors.contractVersion).toBe("1.0.0");
    expect(request).toEqual(vectors.request);
    expect({ job: queuedStatus }).toEqual(vectors.queuedResponse);
    expect(completedStatus).toEqual(vectors.completedStatus);
    expect(parseJetsonDispatchArtifact(vectors.artifact, completedStatus.jobId)).toEqual(
      vectors.artifact,
    );
  });

  it.each(vectors.invalidRequests)("rejects $name (#8142)", ({ name, value }) => {
    expect(() => parseJetsonDispatchRequest(value)).toThrow(invalidRequestErrors[name]);
  });

  it("keeps the published v2 bytes immutable (#8142)", () => {
    expect(createHash("sha256").update(vectorV2Bytes).digest("hex")).toBe(
      JETSON_DISPATCH_V2_SHA256,
    );
  });

  it("accepts every version 2.0.0 compatibility vector (#8142)", () => {
    expect(vectorsV2.contractVersion).toBe(JETSON_DISPATCH_CONTRACT_VERSION);
    expect(requestV2).toEqual(vectorsV2.request);
    expect({ job: queuedStatusV2 }).toEqual(vectorsV2.queuedResponse);
    expect(completedStatusV2).toEqual(vectorsV2.completedStatus);
    expect(parseJetsonDispatchArtifact(vectorsV2.artifact, completedStatusV2.jobId)).toEqual(
      vectorsV2.artifact,
    );
  });

  it.each(vectorsV2.invalidRequests)("rejects v2 $name (#8142)", ({ name, value }) => {
    expect(() => parseJetsonDispatchRequest(value)).toThrow(invalidV2RequestErrors[name]);
  });

  it("rejects a valid status for a different submitted request (#8142)", () => {
    expect(() =>
      parseJetsonDispatchStatusResponse(vectors.queuedResponse, {
        ...request,
        workflowRunAttempt: request.workflowRunAttempt + 1,
      }),
    ).toThrow("Jetson dispatcher response does not match the submitted request");
  });

  it.each([
    {
      name: "an extra status field",
      value: { ...(vectors.queuedResponse as { job: object }).job, command: "untrusted" },
      expectedError:
        "queued Jetson dispatch status fields do not match Jetson dispatch contract 1.0.0",
    },
    {
      name: "a mismatched job ID",
      value: { ...(vectors.queuedResponse as { job: object }).job, jobId: "f".repeat(64) },
      expectedError: "Jetson dispatch status does not match its request and job ID",
    },
    {
      name: "completed cleanup on a queued job",
      value: { ...(vectors.queuedResponse as { job: object }).job, cleanup: "succeeded" },
      expectedError: "queued Jetson dispatch cleanup must be pending",
    },
    {
      name: "a successful result without device identity",
      value: { ...(vectors.completedStatus as Record<string, unknown>), device: undefined },
      expectedError: "successful Jetson dispatch must include device identity",
    },
    {
      name: "a cleanup conclusion mismatch",
      value: {
        ...(vectors.completedStatus as Record<string, unknown>),
        cleanup: "failed",
        conclusion: "failure",
      },
      expectedError: "completed Jetson dispatch result is invalid",
    },
    {
      name: "a successful result with failed cleanup",
      value: {
        ...(vectors.completedStatus as Record<string, unknown>),
        cleanup: "failed",
      },
      expectedError: "completed Jetson dispatch result is invalid",
    },
    {
      name: "a non-string conclusion",
      value: {
        ...(vectors.completedStatus as Record<string, unknown>),
        conclusion: ["success"],
      },
      expectedError: "completed Jetson dispatch result is invalid",
    },
    {
      name: "a non-string cleanup state",
      value: {
        ...(vectors.completedStatus as Record<string, unknown>),
        cleanup: ["succeeded"],
      },
      expectedError: "completed Jetson dispatch result is invalid",
    },
    {
      name: "an out-of-order completion timestamp",
      value: {
        ...(vectors.completedStatus as Record<string, unknown>),
        completedAt: "2026-08-11T23:59:59.000Z",
      },
      expectedError: "completed Jetson dispatch timestamps are invalid",
    },
  ])("rejects $name (#8142)", ({ expectedError, value }) => {
    expect(() => parseJetsonDispatchStatus(value)).toThrow(expectedError);
  });

  it("accepts cleanup success when later device-lock release fails (#8142)", () => {
    const status = {
      ...(vectors.completedStatus as Record<string, unknown>),
      conclusion: "cleanup-failed",
      error: "Jetson lock removal failed: fixture failure",
    };
    const artifact = {
      ...(vectors.artifact as Record<string, unknown>),
      status,
    };

    expect(parseJetsonDispatchStatus(status)).toEqual(status);
    expect(parseJetsonDispatchArtifact(artifact, completedStatus.jobId)).toEqual(artifact);
  });

  it("accepts the backend device-identity bound and rejects larger values (#8142)", () => {
    const baseDevice = (vectors.completedStatus as { device: Record<string, unknown> }).device;
    const bounded = {
      ...(vectors.completedStatus as Record<string, unknown>),
      device: { ...baseDevice, model: "x".repeat(500) },
    };
    const oversized = {
      ...bounded,
      device: { ...baseDevice, model: "x".repeat(501) },
    };

    expect(parseJetsonDispatchStatus(bounded).device?.model).toHaveLength(500);
    expect(() => parseJetsonDispatchStatus(oversized)).toThrow("Jetson device model is invalid");
  });

  it.each([
    {
      name: "an extra artifact field",
      value: { ...(vectors.artifact as Record<string, unknown>), secret: "unexpected" },
      expectedError: "Jetson dispatch artifact fields do not match Jetson dispatch contract 1.0.0",
    },
    {
      name: "a mismatched artifact job ID",
      value: vectors.artifact,
      expectedJobId: "f".repeat(64),
      expectedError: "Jetson dispatch artifact does not match its completed job",
    },
    {
      name: "a noncanonical artifact archive",
      value: {
        ...(vectors.artifact as Record<string, unknown>),
        artifactArchiveBase64: "not base64",
      },
      expectedError: "Jetson artifact archive must be bounded canonical base64",
    },
    {
      name: "a successful result without its archive",
      value: {
        status: (vectors.artifact as { status: unknown }).status,
        log: "fixture log\n",
      },
      expectedError: "successful Jetson dispatch must include its artifact archive",
    },
    {
      name: "a non-string successful conclusion without an archive",
      value: {
        status: {
          ...(vectors.completedStatus as Record<string, unknown>),
          conclusion: ["success"],
        },
        log: "fixture log\n",
      },
      expectedError: "completed Jetson dispatch result is invalid",
    },
  ])("rejects $name (#8142)", ({ expectedError, expectedJobId, value }) => {
    expect(() =>
      parseJetsonDispatchArtifact(value, expectedJobId ?? completedStatus.jobId),
    ).toThrow(expectedError);
  });
});

describe("Jetson dispatch GitHub controller", () => {
  it("binds the candidate and managed-image publication commits into a v2 request (#8142)", () => {
    expect(
      jetsonDispatchRequestFromEnvironment({
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "123456789",
        JETSON_DISPATCH_CANDIDATE_SHA: "a".repeat(40),
        JETSON_DISPATCH_MANAGED_IMAGE_REVISION: "b".repeat(40),
      }),
    ).toEqual(requestV2);
  });

  it("rejects a v2 request without the managed-image publication commit (#8142)", () => {
    expect(() =>
      jetsonDispatchRequestFromEnvironment({
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "123456789",
        JETSON_DISPATCH_CANDIDATE_SHA: "a".repeat(40),
      }),
    ).toThrow("managedImageRevision must be a lowercase 40-character commit SHA");
  });

  it("requests a GitHub OIDC token for the fixed dispatcher audience (#8142)", async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      Response.json({ value: "oidc-token" }),
    );
    const token = createGitHubOidcTokenProvider({ fetchImpl });

    await expect(
      token({
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.test/id-token?ignored=value",
      }),
    ).resolves.toBe("oidc-token");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(input)).searchParams.get("audience")).toBe(JETSON_DISPATCH_AUDIENCE);
    expect(init?.headers).toEqual({ Authorization: "Bearer request-token" });
  });

  it("rejects missing or non-HTTPS GitHub OIDC configuration (#8142)", async () => {
    const token = createGitHubOidcTokenProvider({ fetchImpl: vi.fn() });

    await expect(token({})).rejects.toThrow("GitHub OIDC environment is unavailable");
    await expect(
      token({
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "http://token.actions.test/id-token",
      }),
    ).rejects.toThrow("GitHub OIDC request URL must use HTTPS");
  });

  it("reuses a GitHub OIDC token only during its bounded cache window (#8142)", async () => {
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

  it("sends the exact request with a bearer token and validates the response (#8142)", async () => {
    const tokenProvider = vi.fn(async () => "oidc-token");
    const fetchImpl = vi.fn(async () => Response.json(vectorsV2.queuedResponse, { status: 202 }));

    const response = await dispatcherRequest({
      baseUrl: new URL("https://dispatch.test/"),
      method: "POST",
      path: "v1/jobs",
      body: requestV2,
      maxBytes: 64 * 1024,
      fetchImpl,
      tokenProvider,
    });

    expect(parseJetsonDispatchStatusResponse(response)).toEqual(queuedStatusV2);
    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://dispatch.test/v1/jobs"),
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer oidc-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestV2),
      }),
    );
  });

  it.each([
    undefined,
    "http://dispatch.test",
    "https://user@dispatch.test",
    "https://dispatch.test/v1/jobs",
    "https://dispatch.test/?query=value",
  ])("rejects an unsafe dispatcher URL value %# (#8142)", (value) => {
    expect(() => dispatcherBaseUrl(value)).toThrow();
  });

  it("rejects a dispatcher response that exceeds its byte bound (#8142)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(vectors.queuedResponse), {
          headers: { "Content-Length": "65537" },
          status: 202,
        }),
    );

    await expect(
      dispatcherRequest({
        baseUrl: new URL("https://dispatch.test/"),
        method: "POST",
        path: "v1/jobs",
        body: request,
        maxBytes: 64 * 1024,
        fetchImpl,
        tokenProvider: async () => "oidc-token",
      }),
    ).rejects.toThrow("Jetson dispatcher response is too large");
  });

  it("rejects an oversized streamed response without Content-Length (#8142)", async () => {
    const chunk = new TextEncoder().encode("x".repeat(4096));
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 202 },
        ),
    );

    await expect(
      dispatcherRequest({
        baseUrl: new URL("https://dispatch.test/"),
        method: "GET",
        path: "v1/jobs/test",
        maxBytes: 8 * 1024,
        fetchImpl,
        tokenProvider: async () => "oidc-token",
      }),
    ).rejects.toThrow("Jetson dispatcher response is too large");
  });

  it("retries status transport failures and validates the completed status (#8142)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const requestImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport reset"))
      .mockResolvedValueOnce({ job: completedStatus });

    await expect(
      pollJetsonDispatch({
        baseUrl: new URL("https://dispatch.test/"),
        deadlineMs: 10_000,
        initialStatus: queuedStatus,
        jobId: queuedStatus.jobId,
        now: () => 0,
        request: requestImpl,
        wait: async () => {},
      }),
    ).resolves.toEqual(completedStatus);
  });

  it("requests cancellation when the controller deadline expires (#8142)", async () => {
    const requestImpl = vi.fn(async () => ({ job: queuedStatus }));

    await expect(
      pollJetsonDispatch({
        baseUrl: new URL("https://dispatch.test/"),
        deadlineMs: 10_000,
        initialStatus: queuedStatus,
        jobId: queuedStatus.jobId,
        now: () => 10_000,
        request: requestImpl,
        wait: async () => {},
      }),
    ).rejects.toThrow("Jetson dispatcher did not complete before the controller deadline");
    expect(requestImpl).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: `v1/jobs/${queuedStatus.jobId}` }),
    );
  });

  it("keeps the published response types compatible with the controller (#8142)", () => {
    const typedRequest: JetsonDispatchRequest = request;
    const typedStatus: JetsonDispatchStatus = completedStatus;
    const typedArtifact: JetsonDispatchArtifact = parseJetsonDispatchArtifact(
      vectors.artifact,
      completedStatus.jobId,
    );

    expect([
      typedRequest.schemaVersion,
      typedStatus.schemaVersion,
      typedArtifact.status.schemaVersion,
    ]).toEqual([1, 1, 1]);
  });
});
