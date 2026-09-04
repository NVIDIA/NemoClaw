// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  bindExactArtifact,
  bindNamedExactArtifact,
  downloadBoundArtifact,
  exactArtifactName,
  exactManagedImageCohortArtifactName,
  materializeContractArchive,
  materializeExactJsonArchive,
  type BoundArtifactIdentity,
  type ExactArtifactExpectation,
} from "../../../tools/e2e/exact-artifact-download.mts";
import { validateDcodeBaseImageContract } from "../../../tools/e2e/dcode-base-image-contract.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const EXPECTED: ExactArtifactExpectation = {
  headSha: "a".repeat(40),
  runAttempt: 2,
  runId: 7001,
};

function archive(contents = "{}\n"): Buffer {
  return artifactZip([{ name: "contract.json", contents }]);
}

function metadata(bytes: Buffer, overrides: Record<string, unknown> = {}): unknown {
  const id = 9001;
  return {
    total_count: 1,
    artifacts: [
      {
        id,
        name: exactArtifactName(EXPECTED),
        size_in_bytes: bytes.length,
        expired: false,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        archive_download_url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/${id}/zip`,
        workflow_run: { id: EXPECTED.runId, head_sha: EXPECTED.headSha },
        ...overrides,
      },
    ],
  };
}

function identity(bytes = archive()): BoundArtifactIdentity {
  return bindExactArtifact(metadata(bytes), EXPECTED);
}

function response(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-length": String(bytes.length) },
  });
}

function cancelableResponse(
  status: number,
  headers: Record<string, string> = {},
): { cancel: ReturnType<typeof vi.fn>; response: Response } {
  const cancel = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("cancel failed"));
  return {
    cancel,
    response: new Response(new ReadableStream({ cancel }), { status, headers }),
  };
}

function parseArtifactReadEvidence(message: string): Record<string, string> {
  const [operation, ...fields] = message.trim().split(/\s+/u);
  return {
    operation,
    ...Object.fromEntries(fields.map((field) => field.split("=", 2))),
  };
}

describe("exact artifact download (#9340)", () => {
  it("binds immutable identity before the content read", () => {
    const bytes = archive();
    expect(bindExactArtifact(metadata(bytes), EXPECTED)).toEqual({
      ...EXPECTED,
      archivePath: "/repos/NVIDIA/NemoClaw/actions/artifacts/9001/zip",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      id: 9001,
      name: exactArtifactName(EXPECTED),
      size: bytes.length,
    });
  });

  it("binds another exact contract name without weakening artifact identity", () => {
    const bytes = archive();
    const name = "managed-pr-contract-7001-openclaw";
    const value = metadata(bytes, { name });

    expect(bindNamedExactArtifact(value, EXPECTED, name)).toMatchObject({
      ...EXPECTED,
      id: 9001,
      name,
    });
  });

  it("derives and materializes the bound managed-image cohort artifact", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cohort-artifact-"));
    const bytes = artifactZip([{ name: "cohort.json", contents: '{"contractVersion":2}\n' }]);
    try {
      expect(exactManagedImageCohortArtifactName(EXPECTED)).toBe("managed-image-cohort-7001-2");
      const cohortPath = materializeExactJsonArchive(bytes, directory, "cohort.json");
      expect(JSON.parse(fs.readFileSync(cohortPath, "utf8"))).toEqual({ contractVersion: 2 });
      expect(fs.statSync(cohortPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each([
    ["expired", { expired: true }, "non-expired"],
    ["artifact id URL", { id: 9002 }, "archive URL does not match artifact id"],
    ["name", { name: "another-artifact" }, "missing or ambiguous"],
    ["digest", { digest: "sha256:invalid" }, "digest is invalid"],
    [
      "run",
      { workflow_run: { id: 7002, head_sha: EXPECTED.headSha } },
      "producer run does not match",
    ],
    [
      "head",
      { workflow_run: { id: EXPECTED.runId, head_sha: "b".repeat(40) } },
      "producer head does not match",
    ],
    [
      "archive URL",
      { archive_download_url: "https://example.com/artifact.zip" },
      "archive URL does not match artifact id",
    ],
  ])("rejects %s identity drift", (_field, overrides, message) => {
    expect(() => bindExactArtifact(metadata(archive(), overrides), EXPECTED)).toThrow(message);
  });

  it("rejects ambiguous artifact metadata", () => {
    const value = metadata(archive()) as { artifacts: unknown[]; total_count: number };
    value.artifacts.push(value.artifacts[0]);
    value.total_count = 2;
    expect(() => bindExactArtifact(value, EXPECTED)).toThrow("missing or ambiguous");
  });

  it("retries one transient response against the same artifact and honors Retry-After", async () => {
    const bytes = archive();
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("sensitive upstream body", { status: 503, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(response(bytes));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();
    const log = vi.fn<(message: string) => void>();

    await expect(
      downloadBoundArtifact(identity(bytes), "secret-token", { fetchImpl, log, sleep }),
    ).resolves.toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/9001/zip",
      "https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/9001/zip",
    ]);
    expect(sleep).toHaveBeenCalledWith(2000);
    const evidence = log.mock.calls.map(([message]) => parseArtifactReadEvidence(message));
    expect(evidence).toEqual([
      expect.objectContaining({
        operation: "artifact-content-read",
        attempt: "1",
        status: "503",
        outcome: "retry",
      }),
      expect.objectContaining({
        operation: "artifact-content-read",
        attempt: "2",
        outcome: "passed-after-retry",
      }),
    ]);
    expect(log.mock.calls.flat().join("\n")).not.toMatch(/secret|upstream body|Authorization/u);
  });

  it("cancels a transient response before retry without masking the retry", async () => {
    const bytes = archive();
    const transient = cancelableResponse(503);
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(transient.response)
      .mockImplementationOnce(async () => {
        expect(transient.cancel).toHaveBeenCalledOnce();
        return response(bytes);
      });

    await expect(
      downloadBoundArtifact(identity(bytes), "token", { fetchImpl, sleep: async () => undefined }),
    ).resolves.toEqual(bytes);
    expect(transient.cancel).toHaveBeenCalledOnce();
  });

  it("cancels a terminal non-OK response without masking its HTTP failure", async () => {
    const terminal = cancelableResponse(404);
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(terminal.response);

    await expect(downloadBoundArtifact(identity(), "token", { fetchImpl })).rejects.toThrow(
      "HTTP 404",
    );
    expect(terminal.cancel).toHaveBeenCalledOnce();
  });

  it("keeps default attempt evidence off machine-readable stdout", async () => {
    const bytes = archive();
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(response(bytes));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        downloadBoundArtifact(identity(bytes), "secret-token", { fetchImpl }),
      ).resolves.toEqual(bytes);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        "artifact-content-read attempt=1 outcome=passed-first-attempt",
      );
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("fails after three transient responses without changing identity", async () => {
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 500 }));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();
    await expect(downloadBoundArtifact(identity(), "token", { fetchImpl, sleep })).rejects.toThrow(
      "HTTP 500",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each([408, 429])("retries transient HTTP %i", async (status) => {
    const bytes = archive();
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(response(bytes));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();
    await expect(
      downloadBoundArtifact(identity(bytes), "token", { fetchImpl, sleep }),
    ).resolves.toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a transport failure", async () => {
    const bytes = archive();
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(response(bytes));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();
    await expect(
      downloadBoundArtifact(identity(bytes), "token", { fetchImpl, sleep }),
    ).resolves.toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 410, 422])("does not retry terminal HTTP %i", async (status) => {
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status }));
    await expect(downloadBoundArtifact(identity(), "token", { fetchImpl })).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry digest mismatch", async () => {
    const expectedBytes = archive();
    const actualBytes = Buffer.from(expectedBytes);
    actualBytes[0] ^= 0xff;
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(response(actualBytes));
    await expect(
      downloadBoundArtifact(identity(expectedBytes), "token", { fetchImpl }),
    ).rejects.toThrow("digest");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels a rejected Content-Length response without masking the identity failure", async () => {
    const bytes = archive();
    const mismatched = cancelableResponse(200, { "content-length": String(bytes.length + 1) });
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(mismatched.response);

    await expect(downloadBoundArtifact(identity(bytes), "token", { fetchImpl })).rejects.toThrow(
      "content length",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mismatched.cancel).toHaveBeenCalledOnce();
  });

  it("stops an unbounded response stream before retaining oversized content", async () => {
    const bytes = archive();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.enqueue(new Uint8Array([0x78]));
      },
      cancel,
    });
    const fetchImpl = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(body));

    await expect(downloadBoundArtifact(identity(bytes), "token", { fetchImpl })).rejects.toThrow(
      "content size",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ attempts: 0 }, "attempts must be between"],
    [{ attempts: 4 }, "attempts must be between"],
    [{ timeoutMs: 0 }, "timeout must be between"],
    [{ timeoutMs: 20_001 }, "timeout must be between"],
  ])("rejects invalid download bounds without a request", async (options, message) => {
    const fetchImpl = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
    await expect(
      downloadBoundArtifact(identity(), "token", { ...options, fetchImpl }),
    ).rejects.toThrow(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a multiline token without exposing or sending it", async () => {
    const fetchImpl = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
    const token = "secret-token\nsecond-line";
    const failure = downloadBoundArtifact(identity(), token, { fetchImpl });
    await expect(failure).rejects.toThrow("single-line value");
    await expect(failure).rejects.not.toThrow(/secret-token|second-line/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed archives before writing a contract", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-artifact-"));
    try {
      expect(() => materializeContractArchive(Buffer.from("not a zip"), directory)).toThrow(
        "exactly one contract.json",
      );
      expect(fs.readdirSync(directory)).toEqual([]);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("leaves contract semantics to the existing fail-closed validator", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-artifact-"));
    try {
      const contractPath = materializeContractArchive(archive(), directory);
      const value = JSON.parse(fs.readFileSync(contractPath, "utf8")) as unknown;
      expect(() => validateDcodeBaseImageContract(value, EXPECTED)).toThrow();
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
