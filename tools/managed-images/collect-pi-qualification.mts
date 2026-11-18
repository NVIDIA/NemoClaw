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

function completeRecords(value: unknown, key: "jobs" | "artifacts"): RecordValue[] {
  const page = record(value);
  if (
    !Array.isArray(page[key]) ||
    page.total_count !== page[key].length ||
    page[key].length > 100
  ) {
    throw new Error(`Pi publication ${key} listing is incomplete`);
  }
  return page[key].map(record);
}

function publicationTime(value: unknown): number {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    ? Date.parse(value)
    : Number.NaN;
}

function successfulJob(
  jobs: RecordValue[],
  name: string,
  run: { id: number; attempt: number; headSha: string },
): RecordValue {
  const matches = jobs.filter((job) => job.name === name);
  const job = matches[0];
  if (
    matches.length !== 1 ||
    !job ||
    job.run_id !== run.id ||
    job.run_attempt !== run.attempt ||
    job.head_sha !== run.headSha ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !Number.isSafeInteger(job.id) ||
    Number(job.id) < 1 ||
    !Number.isSafeInteger(job.runner_id) ||
    Number(job.runner_id) < 1 ||
    !Number.isFinite(publicationTime(job.started_at)) ||
    !Number.isFinite(publicationTime(job.completed_at)) ||
    publicationTime(job.completed_at) < publicationTime(job.started_at)
  )
    throw new Error("Pi publication needs one successful matching producer job");
  return job;
}

async function piArtifactSelection(
  run: { id: number; attempt: number; headSha: string },
  request: Request,
) {
  const runPath = `/repos/${REPOSITORY}/actions/runs/${run.id}`;
  const jobs = completeRecords(await request(`${runPath}/jobs?filter=latest&per_page=100`), "jobs");
  const names = [
    "Record managed image publication identity",
    ...ARCHITECTURES.map((arch) => `Build and validate the Pi candidate managed image (${arch})`),
  ];
  const producers = names.map((name) => successfulJob(jobs, name, run));
  const artifacts = completeRecords(
    await request(`${runPath}/artifacts?per_page=100`),
    "artifacts",
  );
  const selected = ARCHITECTURES.map((arch, index) => {
    const job = producers[index + 1]!;
    const pattern = new RegExp(
      `^managed-candidate-contract-${run.id}-([1-9][0-9]*)-pi-${arch}$`,
      "u",
    );
    const matches = artifacts.filter(
      (artifact) =>
        pattern.test(String(artifact.name)) &&
        publicationTime(artifact.created_at) >= publicationTime(job.started_at) &&
        publicationTime(artifact.created_at) <= publicationTime(job.completed_at),
    );
    if (matches.length !== 1) throw new Error("Pi producer artifact is missing or ambiguous");
    const artifact = matches[0]!;
    const attempt = positiveInteger(Number(pattern.exec(String(artifact.name))![1]));
    if (attempt > run.attempt) throw new Error("Pi artifact attempt is newer than qualification");
    return { artifact, attempt };
  });
  const attempt = selected[0]!.attempt;
  if (selected.some((entry) => entry.attempt !== attempt)) {
    throw new Error("Pi receipts must come from one producer attempt");
  }
  if (attempt !== run.attempt) {
    // GitHub copies retained jobs into the rerun with new IDs and run_attempt.
    // Bind their unchanged executions to the original successful producer jobs.
    const original = completeRecords(
      await request(`${runPath}/attempts/${attempt}/jobs?per_page=100`),
      "jobs",
    );
    names.forEach((name, index) => {
      const source = successfulJob(original, name, { ...run, attempt });
      if (
        ["started_at", "completed_at", "runner_id"].some(
          (key) => source[key] !== producers[index]![key],
        )
      ) {
        throw new Error("Pi producer execution changed during qualification");
      }
    });
  }
  return { attempt, artifacts: selected.map((entry) => entry.artifact) };
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
  const selected = await piArtifactSelection(run, request);
  const receipts: Record<string, string> = {};
  const digests: string[] = [];
  const releases = new Set<string>();
  for (const [index, architecture] of ARCHITECTURES.entries()) {
    const name = `managed-candidate-contract-${run.id}-${selected.attempt}-pi-${architecture}`;
    const identity = bindNamedExactArtifact(
      { total_count: 1, artifacts: [selected.artifacts[index]] },
      { headSha: run.headSha, runId: run.id, runAttempt: selected.attempt },
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
      contract.source.cohort !== `ghrun-${run.id}-${selected.attempt}`
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
