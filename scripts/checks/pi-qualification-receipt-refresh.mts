// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Requires both Pi qualification receipts when a Pi image input changes. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as candidateAuthority from "../../src/lib/agent/candidate-authority.ts";
import type {
  ManagedImageContractV1,
  ManagedImagePlatform,
} from "../../src/lib/onboard/managed-image/contract.ts";
import * as managedImageContract from "../../src/lib/onboard/managed-image/contract.ts";
import { directDockerfileCopySources } from "../lib/dockerfile-copy-sources.mts";

type CandidateAuthorityModule = typeof candidateAuthority & { default?: typeof candidateAuthority };
type ManagedImageContractModule = typeof managedImageContract & {
  default?: typeof managedImageContract;
};

type GitResult = {
  error?: string;
  status: number | null;
  stderr?: string;
  stdout: string;
};

type GitRunner = (args: readonly string[]) => GitResult;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PI_DOCKERFILES = ["agents/pi/Dockerfile", "agents/pi/Dockerfile.base"] as const;
const PI_CANDIDATE_AUTHORITY = "src/lib/agent/candidate-authority.ts";
export const PI_QUALIFICATION_RECEIPTS: readonly {
  path: string;
  platform: ManagedImagePlatform;
}[] = [
  {
    path: "ci/pi-agent-qualification-v1-linux-amd64.json",
    platform: "linux/amd64",
  },
  {
    path: "ci/pi-agent-qualification-v1-linux-arm64.json",
    platform: "linux/arm64",
  },
] as const;

function ownsPath(source: string, changedPath: string): boolean {
  const normalizedSource = source.replace(/\/+$/u, "");
  return changedPath === normalizedSource || changedPath.startsWith(`${normalizedSource}/`);
}

function runGit(args: readonly string[]): GitResult {
  const result = spawnSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    error: result.error?.message,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function requireGitOutput(result: GitResult, operation: string): string {
  if (result.error) throw new Error(`${operation}: ${result.error}`);
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(
      `${operation}: git exited ${result.status ?? "without status"}${detail ? ` (${detail})` : ""}`,
    );
  }
  return result.stdout;
}

function mergeBaseRevision(git: GitRunner, baseBranch: string | undefined): string {
  const baseRef = baseBranch ? `origin/${baseBranch}` : "origin/main";
  const result = git(["merge-base", "HEAD", baseRef]);
  if (result.error) {
    throw new Error(
      `Could not run git to resolve the Pi receipt comparison base against ${baseRef} (${result.error})`,
    );
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(
      `Could not resolve the Pi receipt comparison base against ${baseRef}. Fetch ${baseRef} with sufficient history before retrying.${detail ? ` Git reported: ${detail}` : ""}`,
    );
  }
  const revision = result.stdout.trim();
  if (!revision) {
    throw new Error(`Could not resolve the Pi receipt comparison base against ${baseRef}`);
  }
  return revision;
}

function changedPathsFromBase(git: GitRunner, revision: string): string[] {
  return requireGitOutput(
    git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", revision, "HEAD", "--"]),
    `Could not inspect changes after ${revision}`,
  )
    .split("\0")
    .filter(Boolean);
}

function piImageSourcePaths(rootDir: string): string[] {
  const copiedSources = PI_DOCKERFILES.flatMap((dockerfile) =>
    directDockerfileCopySources(path.join(rootDir, dockerfile), dockerfile).map(
      ({ source }) => source,
    ),
  );
  return [...new Set([".dockerignore", ...PI_DOCKERFILES, ...copiedSources])].sort();
}

type ValidatedReceipt = {
  contract: ManagedImageContractV1;
  digest: string;
};

function parseReceipt(
  rootDir: string,
  receipt: { path: string; platform: ManagedImagePlatform },
  acceptedDigests: ReadonlySet<string>,
): ValidatedReceipt {
  const receiptPath = path.join(rootDir, receipt.path);
  if (!fs.existsSync(receiptPath)) {
    throw new Error(
      `Pi image inputs changed but qualification receipt is missing: ${receipt.path}`,
    );
  }
  const contents = fs.readFileSync(receiptPath);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (!acceptedDigests.has(digest)) {
    throw new Error(`${receipt.path} is not present in the Pi candidate receipt authority`);
  }
  const contractModule = managedImageContract as ManagedImageContractModule;
  const parseContract =
    contractModule.parseManagedImageContractV1 ??
    contractModule.default?.parseManagedImageContractV1;
  if (!parseContract) throw new Error("Could not load the managed image contract parser");
  try {
    const parsed = JSON.parse(contents.toString("utf8")) as unknown;
    return { contract: parseContract(parsed, "pi", receipt.platform), digest };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Pi qualification receipt ${receipt.path}: ${detail}`, {
      cause: error,
    });
  }
}

function requireReceiptSourceParity(
  git: GitRunner,
  revision: string,
  comparisonRevision: string,
  imageSourcePaths: readonly string[],
): void {
  const result = git([
    "diff",
    "--quiet",
    revision,
    comparisonRevision,
    "--",
    ...imageSourcePaths,
  ]);
  if (result.error) {
    throw new Error(`Could not run git to validate Pi receipt source parity (${result.error})`);
  }
  if (result.status === 0) return;
  if (result.status === 1) {
    throw new Error(`Pi image inputs changed after receipt source revision ${revision}`);
  }
  const detail = result.stderr?.trim();
  throw new Error(
    `Could not validate Pi receipt source parity: git exited ${result.status ?? "without status"}${detail ? ` (${detail})` : ""}`,
  );
}

function receiptComparisonRevision(git: GitRunner, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "pull_request") {
    return "HEAD";
  }
  const result = git(["rev-parse", "--verify", "HEAD^2"]);
  const revision = requireGitOutput(result, "Could not resolve the exact pull-request head").trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("Could not resolve the exact pull-request head: invalid revision");
  }
  return revision;
}

function validateReceiptPair(
  git: GitRunner,
  rootDir: string,
  imageSourcePaths: readonly string[],
  receipts: readonly { path: string; platform: ManagedImagePlatform }[],
  acceptedDigests: ReadonlySet<string>,
  comparisonRevision: string,
): void {
  const validated = receipts.map((receipt) => parseReceipt(rootDir, receipt, acceptedDigests));
  const contracts = validated.map(({ contract }) => contract);
  const revisions = new Set(contracts.map(({ source }) => source.revision));
  const cohorts = new Set(contracts.map(({ source }) => source.cohort));
  const releases = new Set(contracts.map(({ source }) => source.release));
  if (revisions.size !== 1 || cohorts.size !== 1 || releases.size !== 1) {
    throw new Error("Pi qualification receipts must identify one source, release, and cohort");
  }
  const receiptDigests = new Set(validated.map(({ digest }) => digest));
  if (
    receiptDigests.size !== acceptedDigests.size ||
    [...acceptedDigests].some((digest) => !receiptDigests.has(digest))
  ) {
    throw new Error("Pi candidate receipt authority must exactly match both published receipts");
  }
  requireReceiptSourceParity(
    git,
    contracts[0]!.source.revision,
    comparisonRevision,
    imageSourcePaths,
  );
}

type PiReceiptRefreshCheckOptions = {
  acceptedDigests?: ReadonlySet<string>;
  baseBranch?: string;
  git?: GitRunner;
  headRevision?: string;
  receipts?: readonly { path: string; platform: ManagedImagePlatform }[];
  rootDir?: string;
};

export function checkPiQualificationReceiptRefresh(
  options: PiReceiptRefreshCheckOptions = {},
): void {
  const git = options.git ?? runGit;
  const rootDir = options.rootDir ?? REPO_ROOT;
  const baseBranch = options.baseBranch ?? process.env.GITHUB_BASE_REF?.trim();
  const receipts = options.receipts ?? PI_QUALIFICATION_RECEIPTS;
  const authorityModule = candidateAuthority as CandidateAuthorityModule;
  const acceptedReceiptDigests =
    authorityModule.acceptedCandidateReceiptDigests ??
    authorityModule.default?.acceptedCandidateReceiptDigests;
  if (!acceptedReceiptDigests) {
    throw new Error("Could not load the Pi candidate receipt authority");
  }
  const acceptedDigests = options.acceptedDigests ?? new Set(acceptedReceiptDigests("pi"));
  const revision = mergeBaseRevision(git, baseBranch);
  const changedPaths = changedPathsFromBase(git, revision);
  const imageSourcePaths = piImageSourcePaths(rootDir);
  const imageInputsChanged = changedPaths.some((changedPath) =>
    imageSourcePaths.some((source) => ownsPath(source, changedPath)),
  );
  const receiptPaths = receipts.map(({ path: receipt }) => receipt);
  const receiptAuthorityChanged = changedPaths.some(
    (changedPath) => changedPath === PI_CANDIDATE_AUTHORITY || receiptPaths.includes(changedPath),
  );
  if (!imageInputsChanged && !receiptAuthorityChanged) return;

  const missingReceipts = receiptPaths.filter((receipt) => !changedPaths.includes(receipt));
  if (imageInputsChanged && missingReceipts.length > 0) {
    throw new Error(
      [
        "Pi image inputs changed without refreshing both qualification receipts.",
        "Publish the Linux AMD64 and ARM64 Pi candidate images from the same commit and workflow run.",
        "Update both receipts and replace the Pi candidate authority with the SHA-256 digests of those exact receipt contents.",
        "Update:",
        ...missingReceipts.map((receipt) => `- ${receipt}`),
      ].join("\n"),
    );
  }
  validateReceiptPair(
    git,
    rootDir,
    imageSourcePaths,
    receipts,
    acceptedDigests,
    receiptComparisonRevision(git, options.headRevision),
  );
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  checkPiQualificationReceiptRefresh();
}
