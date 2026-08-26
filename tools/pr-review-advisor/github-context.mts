// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { githubRest, githubRestPaginated } from "../advisors/github.mts";
import {
  getPath,
  isObjectRecord,
  recordItems,
  stringOrDefault,
  stringOrUndefined,
} from "../advisors/json.mts";

export const MAX_PREPARED_GITHUB_CONTEXT_BYTES = 5 * 1024 * 1024;
const OPEN_PR_OVERLAP_LIMIT = 80;
const OPEN_PR_OVERLAP_CONCURRENCY = 6;
const OVERLAP_LINKED_ISSUE_LIMIT = 50;
const OVERLAP_SAME_FILE_SAMPLE_LIMIT = 20;
const OVERLAP_PATH_CHARACTER_LIMIT = 300;
const BODY_CHARACTER_LIMIT = 20_000;
const COMMENT_BODY_CHARACTER_LIMIT = 4_000;

export type OpenPrOverlap = {
  number: number;
  title: string;
  labels: string[];
  linkedIssues: number[];
  linkedIssueCount: number;
  sameFiles: string[];
  sameFileCount: number;
  duplicateLinkedIssues: number[];
  replacesCurrentPr: boolean;
};

type LinkedIssue = {
  number: number;
  issue?: unknown;
  comments?: unknown[];
  fetchError?: string;
};

export type GitHubReviewContext = {
  repo: string;
  prNumber: number;
  fetchError?: string;
  pullRequest?: unknown;
  issueReferenceLines?: string[];
  linkedIssues?: LinkedIssue[];
  openPrOverlaps?: OpenPrOverlap[];
};

export function serializePreparedGitHubContext(context: GitHubReviewContext | null): string {
  const serialized = `${JSON.stringify(context, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_PREPARED_GITHUB_CONTEXT_BYTES) {
    throw new Error("Prepared GitHub context exceeds the 5 MiB limit");
  }
  return serialized;
}

export function readPreparedGitHubContext(
  filePath: string,
  expected: { prNumber?: number; repo?: string } = {},
): GitHubReviewContext | null {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Prepared GitHub context requires secure no-follow file access");
  }

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    throw new Error("Prepared GitHub context must be a regular file", { cause: error });
  }

  const content = Buffer.allocUnsafe(MAX_PREPARED_GITHUB_CONTEXT_BYTES + 1);
  let bytesRead = 0;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("Prepared GitHub context must be a regular file");
    }
    if (stat.size > MAX_PREPARED_GITHUB_CONTEXT_BYTES) {
      throw new Error("Prepared GitHub context exceeds the 5 MiB limit");
    }
    while (bytesRead < content.length) {
      const count = fs.readSync(descriptor, content, bytesRead, content.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (bytesRead > MAX_PREPARED_GITHUB_CONTEXT_BYTES) {
    throw new Error("Prepared GitHub context exceeds the 5 MiB limit");
  }

  const parsed = JSON.parse(content.toString("utf8", 0, bytesRead)) as unknown;
  if (parsed === null) return null;
  if (!isObjectRecord(parsed)) {
    throw new Error("Prepared GitHub context must be a JSON object or null");
  }
  const repo = stringOrUndefined(parsed.repo);
  const prNumber = parsed.prNumber;
  if (!repo || typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("Prepared GitHub context is missing its repository or pull request identity");
  }
  if (expected.repo && repo !== expected.repo) {
    throw new Error("Prepared GitHub context repository does not match the workflow target");
  }
  if (expected.prNumber && prNumber !== expected.prNumber) {
    throw new Error("Prepared GitHub context pull request does not match the workflow target");
  }
  return parsed as GitHubReviewContext;
}

export async function collectGitHubReviewContext(
  env: NodeJS.ProcessEnv,
): Promise<GitHubReviewContext | null> {
  const repo = env.TARGET_REPO || env.GITHUB_REPOSITORY;
  const prNumber = Number.parseInt(
    env.PR_NUMBER || env.GITHUB_REF_NAME?.match(/^(\d+)\//u)?.[1] || "",
    10,
  );
  const preparedPath = env.PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH;
  if (preparedPath) {
    return readPreparedGitHubContext(preparedPath, {
      repo,
      prNumber: Number.isFinite(prNumber) && prNumber > 0 ? prNumber : undefined,
    });
  }

  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!repo || !Number.isFinite(prNumber) || prNumber <= 0 || !token) return null;

  const context: GitHubReviewContext = { repo, prNumber };
  try {
    const [rawPullRequest, openPulls] = await Promise.all([
      githubRest<unknown>(`repos/${repo}/pulls/${prNumber}`, token),
      githubRestPaginated<unknown>(
        `repos/${repo}/pulls?state=open&sort=updated&direction=desc`,
        token,
        100,
      ),
    ]);
    context.pullRequest = summarizePullRequest(rawPullRequest);
    const prTitle = stringOrUndefined(getPath<unknown>(rawPullRequest, ["title"])) || "";
    const prBody = stringOrUndefined(getPath<unknown>(rawPullRequest, ["body"])) || "";
    const prText = [
      prTitle,
      prBody,
      stringOrUndefined(getPath<unknown>(rawPullRequest, ["head", "ref"])),
    ]
      .filter(Boolean)
      .join("\n");
    const issueNumbers = extractIssueRefs(prText, prNumber).slice(0, 5);
    context.issueReferenceLines = [prTitle, ...prBody.split("\n")]
      .map((line) => line.trim())
      .filter((line) => line && extractIssueRefs(line, prNumber).length > 0)
      .map((line) => boundedText(line, 2_000, "issue-reference line") as string)
      .slice(0, 20);
    context.linkedIssues = await Promise.all(
      issueNumbers.map((issue) => collectLinkedIssue(repo, issue, token)),
    );
    context.openPrOverlaps = await collectOpenPrOverlaps(
      repo,
      prNumber,
      token,
      openPulls,
      issueNumbers,
    );
  } catch (error: unknown) {
    context.fetchError = error instanceof Error ? error.message : String(error);
  }
  return context;
}

function summarizePullRequest(value: unknown): unknown {
  if (!isObjectRecord(value)) return value;
  return {
    number: getPath<unknown>(value, ["number"]),
    title: stringOrUndefined(getPath<unknown>(value, ["title"])),
    body: boundedText(getPath<unknown>(value, ["body"]), BODY_CHARACTER_LIMIT, "pull-request body"),
    state: stringOrUndefined(getPath<unknown>(value, ["state"])),
    draft: getPath<unknown>(value, ["draft"]),
    author_association: stringOrUndefined(getPath<unknown>(value, ["author_association"])),
    user: summarizeUser(getPath<unknown>(value, ["user"])),
    labels: summarizeLabels(getPath<unknown>(value, ["labels"])),
    head: summarizeGitRef(getPath<unknown>(value, ["head"])),
    base: summarizeGitRef(getPath<unknown>(value, ["base"])),
    created_at: stringOrUndefined(getPath<unknown>(value, ["created_at"])),
    updated_at: stringOrUndefined(getPath<unknown>(value, ["updated_at"])),
  };
}

function summarizeIssue(value: unknown): unknown {
  if (!isObjectRecord(value)) return value;
  return {
    number: getPath<unknown>(value, ["number"]),
    title: stringOrUndefined(getPath<unknown>(value, ["title"])),
    body: boundedText(getPath<unknown>(value, ["body"]), BODY_CHARACTER_LIMIT, "issue body"),
    state: stringOrUndefined(getPath<unknown>(value, ["state"])),
    state_reason: stringOrUndefined(getPath<unknown>(value, ["state_reason"])),
    author_association: stringOrUndefined(getPath<unknown>(value, ["author_association"])),
    user: summarizeUser(getPath<unknown>(value, ["user"])),
    labels: summarizeLabels(getPath<unknown>(value, ["labels"])),
    created_at: stringOrUndefined(getPath<unknown>(value, ["created_at"])),
    updated_at: stringOrUndefined(getPath<unknown>(value, ["updated_at"])),
  };
}

function summarizeComment(value: unknown): unknown {
  if (!isObjectRecord(value)) return value;
  return {
    id: getPath<unknown>(value, ["id"]),
    body: boundedText(
      getPath<unknown>(value, ["body"]),
      COMMENT_BODY_CHARACTER_LIMIT,
      "issue comment",
    ),
    author_association: stringOrUndefined(getPath<unknown>(value, ["author_association"])),
    user: summarizeUser(getPath<unknown>(value, ["user"])),
    created_at: stringOrUndefined(getPath<unknown>(value, ["created_at"])),
    updated_at: stringOrUndefined(getPath<unknown>(value, ["updated_at"])),
  };
}

function summarizeUser(value: unknown): unknown {
  const login = stringOrUndefined(getPath<unknown>(value, ["login"]));
  return login ? { login } : undefined;
}

function summarizeLabels(value: unknown): Array<Record<string, unknown>> {
  return recordItems(value)
    .map((label) => ({
      name: stringOrUndefined(label.name),
      color: stringOrUndefined(label.color),
      description: boundedText(label.description, 1_000, "label description"),
    }))
    .slice(0, 100);
}

function summarizeGitRef(value: unknown): unknown {
  if (!isObjectRecord(value)) return value;
  return {
    ref: stringOrUndefined(value.ref),
    sha: stringOrUndefined(value.sha),
    repo: {
      full_name: stringOrUndefined(getPath<unknown>(value, ["repo", "full_name"])),
    },
  };
}

function boundedText(value: unknown, limit: number, label: string): string | undefined {
  const text = stringOrUndefined(value);
  if (!text || text.length <= limit) return text;
  const marker = `\n\n[PR Review Advisor truncated content from the middle of this ${label}.]\n\n`;
  const retained = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(retained / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - (retained - headLength))}`;
}

async function collectLinkedIssue(
  repo: string,
  number: number,
  token: string,
): Promise<LinkedIssue> {
  try {
    const [issue, comments] = await Promise.all([
      githubRest<unknown>(`repos/${repo}/issues/${number}`, token),
      githubRestPaginated<unknown>(`repos/${repo}/issues/${number}/comments`, token, 50),
    ]);
    return {
      number,
      issue: summarizeIssue(issue),
      comments: comments.map(summarizeComment),
    };
  } catch (error: unknown) {
    return { number, fetchError: error instanceof Error ? error.message : String(error) };
  }
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function collectOpenPrOverlaps(
  repo: string,
  currentPrNumber: number,
  token: string,
  openPulls: unknown[],
  currentLinkedIssues: number[],
): Promise<OpenPrOverlap[]> {
  const currentFiles = new Set<string>(
    (
      await githubRestPaginated<{ filename?: string }>(
        `repos/${repo}/pulls/${currentPrNumber}/files`,
        token,
        300,
      )
    )
      .map((file) => file.filename)
      .filter((file): file is string => typeof file === "string"),
  );
  const candidatePulls = openPulls
    .filter((pull) => getPath<number>(pull, ["number"]) !== currentPrNumber)
    .slice(0, OPEN_PR_OVERLAP_LIMIT);
  const overlaps = await mapWithConcurrency(
    candidatePulls,
    OPEN_PR_OVERLAP_CONCURRENCY,
    async (pull): Promise<OpenPrOverlap | null> => {
      const number = getPath<number>(pull, ["number"]);
      if (!number) return null;
      const title = stringOrDefault(getPath<unknown>(pull, ["title"]), `PR #${number}`);
      const body = stringOrDefault(getPath<unknown>(pull, ["body"]), "");
      const labels = recordItems(getPath<unknown>(pull, ["labels"]))
        .map((label) => stringOrUndefined(label.name))
        .filter((label): label is string => Boolean(label))
        .slice(0, 100)
        .map((label) => boundedText(label, 200, "pull-request label") as string);
      const pullText = `${title}\n${body}`;
      const allLinkedIssues = extractIssueRefs(pullText, number);
      const replacesCurrentPr = declaresReplacement(pullText, currentPrNumber);
      const duplicateLinkedIssues = allLinkedIssues.filter((issue) =>
        currentLinkedIssues.includes(issue),
      );
      let allSameFiles: string[] = [];
      if (currentFiles.size > 0) {
        try {
          allSameFiles = (
            await githubRestPaginated<{ filename?: string }>(
              `repos/${repo}/pulls/${number}/files`,
              token,
              300,
            )
          )
            .map((file) => file.filename)
            .filter((file): file is string => typeof file === "string" && currentFiles.has(file));
        } catch {
          allSameFiles = [];
        }
      }
      const uniqueSameFiles = [...new Set(allSameFiles)];
      if (
        uniqueSameFiles.length === 0 &&
        duplicateLinkedIssues.length === 0 &&
        !replacesCurrentPr
      )
        return null;
      return {
        number,
        title: boundedText(title, 1_000, "pull-request title") as string,
        labels,
        linkedIssues: allLinkedIssues.slice(0, OVERLAP_LINKED_ISSUE_LIMIT),
        linkedIssueCount: allLinkedIssues.length,
        sameFiles: uniqueSameFiles
          .slice(0, OVERLAP_SAME_FILE_SAMPLE_LIMIT)
          .map(
            (file) => boundedText(file, OVERLAP_PATH_CHARACTER_LIMIT, "overlapping path") as string,
          ),
        sameFileCount: uniqueSameFiles.length,
        duplicateLinkedIssues,
        replacesCurrentPr,
      };
    },
  );
  return overlaps
    .filter((overlap): overlap is OpenPrOverlap => overlap !== null)
    .sort(
      (a, b) =>
        Number(b.replacesCurrentPr) - Number(a.replacesCurrentPr) ||
        b.sameFileCount - a.sameFileCount ||
        b.duplicateLinkedIssues.length - a.duplicateLinkedIssues.length ||
        a.number - b.number,
    )
    .slice(0, 25);
}

export function declaresReplacement(text: string, currentPrNumber: number): boolean {
  const relationPattern = /\b(?:replaces|supersedes)\s+(?:pr\s*)?#(\d+)\b/giu;
  return [...text.matchAll(relationPattern)].some(
    (match) => Number.parseInt(match[1] || "", 10) === currentPrNumber,
  );
}

export async function writeGitHubReviewContext(
  env: NodeJS.ProcessEnv,
  outputPath: string,
): Promise<void> {
  const context = await collectGitHubReviewContext(env);
  const outputDirectory = path.dirname(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedOutput !== path.join(path.resolve(outputDirectory), "github-context.json")) {
    throw new Error("Prepared GitHub context output must be named github-context.json");
  }
  fs.writeFileSync(resolvedOutput, serializePreparedGitHubContext(context), {
    flag: "wx",
    mode: 0o600,
  });
}

export function hasOpenPrReplacement(overlaps: readonly OpenPrOverlap[] | undefined): boolean {
  return overlaps?.some((overlap) => overlap.replacesCurrentPr) ?? false;
}

export function extractIssueRefs(text: string, prNumber: number): number[] {
  const numbers = new Set<number>();
  const relationPattern =
    /\b(?:fixes|closes|resolves|refs?|references?|related(?:\s+issue)?|linked(?:\s+issue)?|follow[- ]?up(?:\s+to)?)\s+(#\d+(?:\s*(?:,\s*(?:and\s+)?|and\s+|&\s*)#\d+)*)/giu;
  for (const relation of text.matchAll(relationPattern)) {
    for (const match of (relation[1] ?? "").matchAll(/#(\d+)/gu)) {
      const number = Number.parseInt(match[1] || "", 10);
      if (Number.isFinite(number) && number > 0 && number !== prNumber) numbers.add(number);
    }
  }
  for (const pattern of [/\(#(\d+)\)/gu, /issue[-_/](\d+)/giu]) {
    for (const match of text.matchAll(pattern)) {
      const number = Number.parseInt(match[1] || "", 10);
      if (Number.isFinite(number) && number > 0 && number !== prNumber) numbers.add(number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeGitHubReviewContext(process.env, "artifacts/pr-review-advisor-context/github-context.json");
}
