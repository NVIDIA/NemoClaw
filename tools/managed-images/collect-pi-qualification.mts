// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readValidatedArtifactZipEntries } from "../../scripts/lib/read-artifact-zip.mts";
import { githubRequest } from "../e2e/base-image-publication.mts";
import {
  bindNamedExactArtifact,
  downloadBoundArtifact,
  type BoundArtifactIdentity,
} from "../e2e/exact-artifact-download.mts";
import { selectManagedImagePublicationRun } from "../e2e/pr-managed-image-publication.mts";
import { validateCandidateContract } from "./validate-candidate-contract.mts";

const REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW = ".github/workflows/managed-images.yaml";
const AUTHORITY = "src/lib/agent/candidate-authority.ts";
const ARCHITECTURES = ["amd64", "arm64"] as const;
const receiptPath = (architecture: string) =>
  `ci/pi-agent-qualification-v1-linux-${architecture}.json`;

type Request = (apiPath: string) => Promise<unknown>;
type Expectation = { prNumber: number; runId: number; candidateSha: string };
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi publication metadata must be an object");
  }
  return value as RecordValue;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("PR, run and workflow identifiers must be positive safe integers");
  }
  return Number(value);
}

function requireCurrentPr(value: unknown, expected: Expectation): void {
  const pr = record(value);
  const source = record(pr.head);
  const base = record(pr.base);
  if (
    pr.number !== expected.prNumber ||
    pr.state !== "open" ||
    source.sha !== expected.candidateSha ||
    record(source.repo).full_name !== REPOSITORY ||
    record(base.repo).full_name !== REPOSITORY
  ) {
    throw new Error("Pi receipt collection requires the current open upstream PR commit");
  }
}

/** Collect both immutable receipts without changing checkout files or granting runtime authority. */
export async function collectPiQualification(
  expected: Expectation,
  request: Request,
  download: (identity: BoundArtifactIdentity) => Promise<Buffer>,
): Promise<{ receipts: Record<string, string>; digests: string[] }> {
  positiveInteger(expected.prNumber);
  positiveInteger(expected.runId);
  if (!/^[0-9a-f]{40}$/u.test(expected.candidateSha)) throw new Error("Invalid candidate SHA");
  const prPath = `/repos/${REPOSITORY}/pulls/${expected.prNumber}`;
  requireCurrentPr(await request(prPath), expected);
  const workflow = record(
    await request(`/repos/${REPOSITORY}/actions/workflows/managed-images.yaml`),
  );
  if (workflow.path !== WORKFLOW || workflow.state !== "active") {
    throw new Error("Pi publication workflow identity is invalid");
  }
  const runPath = `/repos/${REPOSITORY}/actions/runs/${expected.runId}`;
  const readRun = async () => {
    const payload = record(await request(runPath));
    const run = selectManagedImagePublicationRun(
      { total_count: 1, workflow_runs: [payload] },
      {
        headSha: expected.candidateSha,
        prNumber: expected.prNumber,
        workflowId: positiveInteger(workflow.id),
      },
    );
    if (run.id !== expected.runId) throw new Error("Pi publication run identity changed");
    return run;
  };
  const run = await readRun();
  const receipts: Record<string, string> = {};
  const digests: string[] = [];
  const releases = new Set<string>();
  for (const architecture of ARCHITECTURES) {
    const name = `managed-candidate-contract-${run.id}-${run.attempt}-pi-${architecture}`;
    const identity = bindNamedExactArtifact(
      await request(`${runPath}/artifacts?name=${name}&per_page=100`),
      { headSha: run.headSha, runId: run.id, runAttempt: run.attempt },
      name,
    );
    const archive = await download(identity);
    if (
      archive.length !== identity.size ||
      `sha256:${createHash("sha256").update(archive).digest("hex")}` !== identity.digest
    ) {
      throw new Error("Pi publication archive does not match its authenticated identity");
    }
    const entries = readValidatedArtifactZipEntries(archive, {
      maxEntries: 1,
      maxTotalUncompressedBytes: 64 * 1024,
    });
    if (entries?.length !== 1 || entries[0]?.name !== "contract.json") {
      throw new Error("Pi publication archive must contain only contract.json");
    }
    const bytes = entries[0].bytes;
    const contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const contract = validateCandidateContract(JSON.parse(contents), `linux/${architecture}`);
    if (
      contract.agent !== "pi" ||
      contract.source.revision !== expected.candidateSha ||
      contract.source.cohort !== `ghrun-${run.id}-${run.attempt}`
    ) {
      throw new Error("Pi receipt does not match the publication commit and attempt");
    }
    releases.add(contract.source.release);
    receipts[receiptPath(architecture)] = contents;
    digests.push(createHash("sha256").update(bytes).digest("hex"));
  }
  if (releases.size !== 1) throw new Error("Pi receipts must identify one release");
  if ((await readRun()).attempt !== run.attempt) throw new Error("Pi publication attempt changed");
  requireCurrentPr(await request(prPath), expected);
  return { receipts, digests };
}

function replacementPatch(file: string, before: string, after: string): string {
  if (before === after) return "";
  const lines = (text: string, prefix: string) => {
    const parts = text.split("\n");
    const terminated = parts.pop() === "";
    if (!terminated) parts.push(text.slice(text.lastIndexOf("\n") + 1));
    return {
      count: parts.length,
      text:
        parts.map((line) => `${prefix}${line}\n`).join("") +
        (terminated ? "" : "\\ No newline at end of file\n"),
    };
  };
  const oldLines = lines(before, "-");
  const newLines = lines(after, "+");
  return (
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` +
    `@@ -1,${oldLines.count} +1,${newLines.count} @@\n${oldLines.text}${newLines.text}`
  );
}

/** Generate a reviewable three-file patch; existing CI still checks source parity and authority. */
export function piQualificationPatch(
  collected: Awaited<ReturnType<typeof collectPiQualification>>,
  originals: Record<string, string>,
): string {
  const authority = originals[AUTHORITY];
  const pattern = /pi: Object\.freeze\(\[\s*"[a-f0-9]{64}",\s*"[a-f0-9]{64}",?\s*\]\)/gu;
  if (
    !authority ||
    [...authority.matchAll(pattern)].length !== 1 ||
    collected.digests.length !== 2 ||
    collected.digests.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))
  ) {
    throw new Error("Pi authority must contain one two-receipt declaration");
  }
  const updates: Record<string, string> = {
    ...collected.receipts,
    [AUTHORITY]: authority.replace(
      pattern,
      `pi: Object.freeze([\n    "${collected.digests[0]}",\n    "${collected.digests[1]}",\n  ])`,
    ),
  };
  return [...ARCHITECTURES.map(receiptPath), AUTHORITY]
    .map((file) => {
      if (typeof originals[file] !== "string" || typeof updates[file] !== "string") {
        throw new Error(`Missing Pi refresh input: ${file}`);
      }
      return replacementPatch(file, originals[file], updates[file]);
    })
    .join("");
}

/** Print a patch from authenticated artifacts; never apply, commit, push, or dispatch it. */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  if (argv.length !== 2 || argv.some((value) => !/^[1-9][0-9]*$/u.test(value))) {
    throw new Error("Usage: collect-pi-qualification.mts <PR number> <managed-images run ID>");
  }
  const token = env.GITHUB_TOKEN ?? "";
  if (!token || /[\r\n]/u.test(token)) throw new Error("GITHUB_TOKEN is required");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
  const candidateSha = git("rev-parse", "HEAD").trim();
  const files = [...ARCHITECTURES.map(receiptPath), AUTHORITY];
  const originals = Object.fromEntries(
    files.map((file) => [file, git("show", `${candidateSha}:${file}`)]),
  );
  const collected = await collectPiQualification(
    {
      candidateSha,
      prNumber: positiveInteger(Number(argv[0])),
      runId: positiveInteger(Number(argv[1])),
    },
    (apiPath) => githubRequest(apiPath, token),
    (identity) => downloadBoundArtifact(identity, token),
  );
  if (git("rev-parse", "HEAD").trim() !== candidateSha) throw new Error("Local commit changed");
  process.stdout.write(piQualificationPatch(collected, originals));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main();
}
