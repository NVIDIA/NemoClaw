// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_CONTRACT_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

type JsonRecord = Record<string, unknown>;

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

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

export function exactArtifactName(expected: ExactArtifactExpectation): string {
  return `managed-base-${expected.runId}-${expected.runAttempt}-langchain-deepagents-code`;
}

export function bindExactArtifact(
  value: unknown,
  expected: ExactArtifactExpectation,
): BoundArtifactIdentity {
  const page = record(value, "artifact response");
  if (!Array.isArray(page.artifacts)) throw new Error("artifact response must contain artifacts");
  const expectedName = exactArtifactName(expected);
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
  if (
    expected.runId !== positiveInteger(expected.runId, "expected run id") ||
    expected.runAttempt !== positiveInteger(expected.runAttempt, "expected run attempt") ||
    !SHA_PATTERN.test(expected.headSha) ||
    artifact.expired !== false ||
    run.id !== expected.runId ||
    run.head_sha !== expected.headSha ||
    typeof artifact.digest !== "string" ||
    !DIGEST_PATTERN.test(artifact.digest) ||
    size > MAX_ARCHIVE_BYTES ||
    archiveUrl.origin !== API_ROOT ||
    archiveUrl.pathname !== archivePath
  ) {
    throw new Error("exact artifact identity is invalid");
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

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

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
      archive = Buffer.from(await response.arrayBuffer());
    } catch {
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

export function materializeContractArchive(archive: Buffer, outputDirectory: string): string {
  const entries = listValidatedArtifactZipEntries(archive, { maxEntries: 2 });
  if (JSON.stringify(entries) !== JSON.stringify([CONTRACT_FILE])) {
    throw new Error("artifact archive must contain exactly one contract.json regular file");
  }
  const contract = readValidatedArtifactZipEntryBytes(archive, CONTRACT_FILE, {
    maxBytes: MAX_CONTRACT_BYTES,
    maxEntries: 2,
  });
  if (!contract) throw new Error("artifact contract archive is malformed");
  const resolvedDirectory = path.resolve(outputDirectory);
  mkdirSync(resolvedDirectory, { mode: 0o700, recursive: true });
  const contractPath = path.join(resolvedDirectory, CONTRACT_FILE);
  writeFileSync(contractPath, contract, { mode: 0o600 });
  return contractPath;
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  return positiveInteger(Number(value), label);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.length !== 1) throw new Error("expected one artifact output directory");
  const token = env.GITHUB_TOKEN ?? "";
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const expected = {
    headSha: env.PUBLICATION_HEAD_SHA ?? "",
    runAttempt: requiredInteger(env.PUBLICATION_RUN_ATTEMPT, "PUBLICATION_RUN_ATTEMPT"),
    runId: requiredInteger(env.PUBLICATION_RUN_ID, "PUBLICATION_RUN_ID"),
  };
  const name = exactArtifactName(expected);
  const response = await githubRequest(
    `/repos/${REPOSITORY}/actions/runs/${expected.runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
    token,
  );
  const identity = bindExactArtifact(response, expected);
  const archive = await downloadBoundArtifact(identity, token);
  materializeContractArchive(archive, argv[0]);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown exact artifact download error");
    process.exitCode = 1;
  }
}
