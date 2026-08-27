// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  listValidatedArtifactZipEntries,
  readValidatedArtifactZipEntryBytes,
} from "../../scripts/scorecard/read-artifact-zip.mts";
import { githubRequest } from "./base-image-publication.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const API_ROOT = "https://api.github.com";
const CONTRACT_FILE = "contract.json";
const COHORT_FILE = "cohort.json";
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_CONTRACT_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

type JsonRecord = Record<string, unknown>;

class TerminalArtifactContentError extends Error {}

export interface ExactArtifactExpectation {
  headSha: string;
  runAttempt: number;
  runId: number;
}

export interface BoundArtifactIdentity extends ExactArtifactExpectation {
  archivePath: string;
  digest: string;
  id: number;
  name: string;
  size: number;
}

export interface ArtifactDownloadOptions {
  attempts?: number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

/** Require an untrusted metadata value to be a plain JSON record. */
function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

/** Parse a positive safe integer from untrusted metadata. */
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

/** Derive the immutable contract artifact name for one publication attempt. */
export function exactArtifactName(expected: ExactArtifactExpectation): string {
  return `managed-base-${expected.runId}-${expected.runAttempt}-langchain-deepagents-code`;
}

/** Derive the immutable all-agent cohort artifact name for one publication attempt. */
export function exactManagedImageCohortArtifactName(expected: ExactArtifactExpectation): string {
  return `managed-image-cohort-${expected.runId}-${expected.runAttempt}`;
}

/** Bind one named artifact and validate every immutable producer attribute. */
export function bindNamedExactArtifact(
  value: unknown,
  expected: ExactArtifactExpectation,
  expectedName: string,
): BoundArtifactIdentity {
  positiveInteger(expected.runId, "expected run id");
  positiveInteger(expected.runAttempt, "expected run attempt");
  if (!SHA_PATTERN.test(expected.headSha)) throw new Error("expected head SHA is invalid");
  if (!expectedName || expectedName.includes("/") || expectedName.includes("\\")) {
    throw new Error("expected artifact name is invalid");
  }

  const page = record(value, "artifact response");
  if (!Array.isArray(page.artifacts)) throw new Error("artifact response must contain artifacts");
  const matches = page.artifacts
    .map((artifact) => record(artifact, "artifact"))
    .filter((artifact) => artifact.name === expectedName);
  if (matches.length !== 1 || page.total_count !== 1) {
    throw new Error("exact artifact identity is missing or ambiguous");
  }

  const artifact = matches[0]!;
  const run = record(artifact.workflow_run, "artifact workflow run");
  const id = positiveInteger(artifact.id, "artifact id");
  const size = positiveInteger(artifact.size_in_bytes, "artifact size");
  const archivePath = `/repos/${REPOSITORY}/actions/artifacts/${id}/zip`;
  let archiveUrl: URL;
  try {
    archiveUrl = new URL(String(artifact.archive_download_url));
  } catch {
    throw new Error("artifact archive URL is invalid");
  }
  if (artifact.expired !== false) throw new Error("artifact must be non-expired");
  if (run.id !== expected.runId) throw new Error("artifact producer run does not match");
  if (run.head_sha !== expected.headSha) throw new Error("artifact producer head does not match");
  if (typeof artifact.digest !== "string" || !DIGEST_PATTERN.test(artifact.digest)) {
    throw new Error("artifact digest is invalid");
  }
  if (size > MAX_ARCHIVE_BYTES) throw new Error("artifact size exceeds the archive limit");
  if (archiveUrl.origin !== API_ROOT || archiveUrl.pathname !== archivePath) {
    throw new Error("artifact archive URL does not match artifact id");
  }
  return {
    ...expected,
    archivePath,
    digest: artifact.digest,
    id,
    name: expectedName,
    size,
  };
}

/** Bind the immutable Deep Agents Code base-image contract artifact. */
export function bindExactArtifact(
  value: unknown,
  expected: ExactArtifactExpectation,
): BoundArtifactIdentity {
  return bindNamedExactArtifact(value, expected, exactArtifactName(expected));
}

/** Calculate bounded server-directed or linear retry delay. */
function retryDelay(response: Response, attempt: number, now: () => number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^(0|[1-9][0-9]*)$/u.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, MAX_RETRY_DELAY_MS);
  }
  if (retryAfter) {
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) {
      return Math.min(Math.max(0, retryDate - now()), MAX_RETRY_DELAY_MS);
    }
  }
  return Math.min(attempt * 1000, MAX_RETRY_DELAY_MS);
}

/** Classify the narrow HTTP status allowlist eligible for content retry. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Read one response stream without retaining bytes beyond the bound identity size. */
async function readBoundedResponseBody(response: Response, expectedSize: number): Promise<Buffer> {
  if (!response.body) throw new TerminalArtifactContentError("artifact response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedSize || total > MAX_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TerminalArtifactContentError(
          "artifact content size does not match the bound identity",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Download a bound artifact with narrow retries and fail-closed integrity checks. */
export async function downloadBoundArtifact(
  identity: BoundArtifactIdentity,
  token: string,
  options: ArtifactDownloadOptions = {},
): Promise<Buffer> {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new Error(`artifact attempts must be between 1 and ${MAX_ATTEMPTS}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) {
    throw new Error(`artifact timeout must be between 1 and ${REQUEST_TIMEOUT_MS} milliseconds`);
  }
  if (!token || token.includes("\r") || token.includes("\n")) {
    throw new Error("GitHub token must be a non-empty single-line value");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${API_ROOT}${identity.archivePath}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "NemoClaw-exact-artifact-download",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      const terminal = attempt === attempts;
      log(
        `artifact-content-read attempt=${attempt} class=transport outcome=${terminal ? "exhausted" : "retry"}`,
      );
      if (terminal) throw new Error("artifact content read exhausted after transport failures");
      await sleep(Math.min(attempt * 1000, MAX_RETRY_DELAY_MS));
      continue;
    }

    if (!response.ok) {
      const transient = isTransientStatus(response.status);
      const terminal = !transient || attempt === attempts;
      log(
        `artifact-content-read attempt=${attempt} status=${response.status} outcome=${terminal ? (transient ? "exhausted" : "failed-no-retry") : "retry"}`,
      );
      if (terminal) {
        throw new Error(`artifact content read failed with HTTP ${response.status}`);
      }
      await sleep(retryDelay(response, attempt, now));
      continue;
    }

    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      (!/^(0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) !== identity.size)
    ) {
      throw new Error("artifact content length does not match the bound identity");
    }
    let archive: Buffer;
    try {
      archive = await readBoundedResponseBody(response, identity.size);
    } catch (error) {
      if (error instanceof TerminalArtifactContentError) throw error;
      const terminal = attempt === attempts;
      log(
        `artifact-content-read attempt=${attempt} class=transport outcome=${terminal ? "exhausted" : "retry"}`,
      );
      if (terminal) throw new Error("artifact content read exhausted while reading the response");
      await sleep(Math.min(attempt * 1000, MAX_RETRY_DELAY_MS));
      continue;
    }
    if (archive.length !== identity.size) {
      throw new Error("artifact content size does not match the bound identity");
    }
    const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    if (digest !== identity.digest) {
      throw new Error("artifact content digest does not match the bound identity");
    }
    log(
      `artifact-content-read attempt=${attempt} outcome=${attempt === 1 ? "passed-first-attempt" : "passed-after-retry"}`,
    );
    return archive;
  }

  throw new Error("artifact content read failed unexpectedly");
}

/** Extract the sole bounded contract file from a validated artifact ZIP. */
export function materializeExactJsonArchive(
  archive: Buffer,
  outputDirectory: string,
  fileName: typeof CONTRACT_FILE | typeof COHORT_FILE,
): string {
  const entries = listValidatedArtifactZipEntries(archive, { maxEntries: 2 });
  if (JSON.stringify(entries) !== JSON.stringify([fileName])) {
    throw new Error(`artifact archive must contain exactly one ${fileName} regular file`);
  }
  const contract = readValidatedArtifactZipEntryBytes(archive, fileName, {
    maxBytes: MAX_CONTRACT_BYTES,
    maxEntries: 2,
  });
  if (!contract) throw new Error("artifact contract archive is malformed");
  const resolvedDirectory = path.resolve(outputDirectory);
  mkdirSync(resolvedDirectory, { mode: 0o700, recursive: true });
  const contractPath = path.join(resolvedDirectory, fileName);
  writeFileSync(contractPath, contract, { mode: 0o600 });
  return contractPath;
}

/** Extract the sole bounded contract file from a validated artifact ZIP. */
export function materializeContractArchive(archive: Buffer, outputDirectory: string): string {
  return materializeExactJsonArchive(archive, outputDirectory, CONTRACT_FILE);
}

/** Read one required positive integer environment value. */
function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

/** Resolve, download, and materialize the exact publication contract artifact. */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.length !== 1) throw new Error("expected one artifact output directory");
  const token = env.GITHUB_TOKEN ?? "";
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const expected = {
    headSha: env.PUBLICATION_HEAD_SHA ?? "",
    runAttempt: requiredInteger(env.PUBLICATION_RUN_ATTEMPT, "PUBLICATION_RUN_ATTEMPT"),
    runId: requiredInteger(env.PUBLICATION_RUN_ID, "PUBLICATION_RUN_ID"),
  };
  const kind = env.PUBLICATION_ARTIFACT_KIND ?? "dcode-base";
  if (kind !== "dcode-base" && kind !== "managed-image-cohort") {
    throw new Error("PUBLICATION_ARTIFACT_KIND must be dcode-base or managed-image-cohort");
  }
  const name =
    kind === "managed-image-cohort"
      ? exactManagedImageCohortArtifactName(expected)
      : exactArtifactName(expected);
  const fileName = kind === "managed-image-cohort" ? COHORT_FILE : CONTRACT_FILE;
  const response = await githubRequest(
    `/repos/${REPOSITORY}/actions/runs/${expected.runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
    token,
  );
  const identity = bindNamedExactArtifact(response, expected, name);
  const archive = await downloadBoundArtifact(identity, token);
  materializeExactJsonArchive(archive, argv[0], fileName);
  if (env.GITHUB_OUTPUT) {
    const provenance = JSON.stringify({
      artifactDigest: identity.digest,
      artifactId: identity.id,
      artifactName: identity.name,
      revision: identity.headSha,
      runAttempt: identity.runAttempt,
      runId: identity.runId,
    });
    appendFileSync(env.GITHUB_OUTPUT, `provenance=${provenance}\n`, "utf8");
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown exact artifact download error");
    process.exitCode = 1;
  }
}
