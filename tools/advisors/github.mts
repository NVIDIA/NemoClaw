// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type GitHubComment = {
  id: number;
  body?: string;
  user?: { login?: string };
};

export type GitHubRequestOptions = {
  method?: string;
  body?: unknown;
  userAgent?: string;
  signal?: AbortSignal;
};

export type GitHubApiResponse<T> = {
  data: T;
  status: number;
  requestId?: string;
};

export type GitHubApiFailureKind = "http" | "decode";

const MAX_GITHUB_RESPONSE_EXCERPT_CHARS = 512;
const GITHUB_REQUEST_ID_PATTERN = /^[A-Za-z0-9:-]{1,128}$/u;

export function isValidGithubRequestId(value: unknown): value is string {
  return typeof value === "string" && GITHUB_REQUEST_ID_PATTERN.test(value);
}

function responseExcerpt(text: string): string {
  const singleLine = text
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return singleLine.length > MAX_GITHUB_RESPONSE_EXCERPT_CHARS
    ? `${singleLine.slice(0, MAX_GITHUB_RESPONSE_EXCERPT_CHARS - 3)}...`
    : singleLine;
}

function responseRequestId(response: Response): string | undefined {
  const headers = response.headers as Headers | undefined;
  const requestId =
    headers && typeof headers.get === "function"
      ? headers.get("x-github-request-id")?.trim()
      : undefined;
  return isValidGithubRequestId(requestId) ? requestId : undefined;
}

export class GitHubApiError extends Error {
  readonly kind: GitHubApiFailureKind;
  readonly method: string;
  readonly apiPath: string;
  readonly status: number;
  readonly requestId?: string;
  readonly responseExcerpt: string;

  constructor(options: {
    kind: GitHubApiFailureKind;
    method: string;
    apiPath: string;
    status: number;
    requestId?: string;
    responseText: string;
    cause?: unknown;
  }) {
    const excerpt = responseExcerpt(options.responseText);
    const message =
      options.kind === "http"
        ? `GitHub API ${options.apiPath} failed: ${options.status}${excerpt ? ` ${excerpt}` : ""}`
        : `GitHub API ${options.apiPath} returned invalid JSON: ${options.status}`;
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubApiError";
    this.kind = options.kind;
    this.method = options.method;
    this.apiPath = options.apiPath;
    this.status = options.status;
    this.requestId = options.requestId;
    this.responseExcerpt = excerpt;
  }
}

export async function githubRest<T>(apiPath: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com/${apiPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`GitHub REST ${apiPath} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export async function githubRestPaginated<T>(
  apiPath: string,
  token: string,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; results.length < limit; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const items = await githubRest<T[]>(
      `${apiPath}${separator}per_page=${Math.min(100, limit - results.length)}&page=${page}`,
      token,
    );
    results.push(...items);
    if (items.length < 100) break;
  }
  return results;
}

export async function githubGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok)
    throw new Error(`GitHub GraphQL failed: ${response.status} ${await response.text()}`);
  const payload = (await response.json()) as {
    data?: unknown;
    errors?: Array<{ message?: string }>;
  };
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const message = payload.errors
      .map((error) => error?.message || "unknown GraphQL error")
      .join("; ");
    const error = new Error(`GitHub GraphQL returned errors: ${message}`) as Error & {
      payload?: unknown;
    };
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function githubApiWithResponse<T>(
  apiPath: string,
  token: string,
  options: GitHubRequestOptions = {},
): Promise<GitHubApiResponse<T>> {
  // lgtm[js/file-access-to-http] Advisor workflows intentionally send normalized
  // artifact summaries and strictly validated dispatch inputs to GitHub APIs.
  // Callers construct apiPath from fixed workflow/comment endpoints, not PR text.
  const method = options.method || "GET";
  const response = await fetch(`https://api.github.com/${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const requestId = responseRequestId(response);
  const text = await response.text();
  if (!response.ok) {
    throw new GitHubApiError({
      kind: "http",
      method,
      apiPath,
      status: response.status,
      requestId,
      responseText: text,
    });
  }
  if (!text) {
    return { data: undefined as T, status: response.status, requestId };
  }
  try {
    return {
      data: JSON.parse(text) as T,
      status: response.status,
      requestId,
    };
  } catch (error) {
    throw new GitHubApiError({
      kind: "decode",
      method,
      apiPath,
      status: response.status,
      requestId,
      responseText: text,
      cause: error,
    });
  }
}

export async function githubApi<T>(
  apiPath: string,
  token: string,
  options: GitHubRequestOptions = {},
): Promise<T> {
  return (await githubApiWithResponse<T>(apiPath, token, options)).data;
}

export async function upsertStickyComment({
  repo,
  pr,
  token,
  marker,
  body,
  label,
  userAgent,
  bodyForComment,
}: {
  repo: string;
  pr: string;
  token: string;
  marker: string;
  body: string;
  label: string;
  userAgent?: string;
  bodyForComment?: (comment: GitHubComment) => string;
}): Promise<void> {
  const existing = await findExistingComment(repo, pr, token, marker, userAgent);
  if (existing) {
    await githubApi(`repos/${repo}/issues/comments/${existing.id}`, token, {
      method: "PATCH",
      body: { body: bodyForComment ? bodyForComment(existing) : body },
      userAgent,
    });
    console.log(`Updated ${label} comment on ${repo}#${pr}`);
  } else {
    const created = await githubApi<GitHubComment>(`repos/${repo}/issues/${pr}/comments`, token, {
      method: "POST",
      body: { body },
      userAgent,
    });
    if (bodyForComment) {
      await githubApi(`repos/${repo}/issues/comments/${created.id}`, token, {
        method: "PATCH",
        body: { body: bodyForComment(created) },
        userAgent,
      });
    }
    console.log(`Created ${label} comment on ${repo}#${pr}`);
  }
}

export async function deleteBotOwnedStickyComments({
  repo,
  pr,
  token,
  markers,
  label,
  userAgent,
}: {
  repo: string;
  pr: string;
  token: string;
  markers: readonly string[];
  label: string;
  userAgent?: string;
}): Promise<number> {
  if (markers.length === 0) return 0;
  const comments: GitHubComment[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubApi<GitHubComment[]>(
      `repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`,
      token,
      { userAgent },
    );
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const matches = comments.filter((comment) => {
    const body = comment.body;
    return (
      Number.isSafeInteger(comment.id) &&
      comment.id > 0 &&
      comment.user?.login === "github-actions[bot]" &&
      typeof body === "string" &&
      markers.some((marker) => firstCommentLine(body) === marker)
    );
  });
  for (const comment of matches) {
    await githubApi(`repos/${repo}/issues/comments/${comment.id}`, token, {
      method: "DELETE",
      userAgent,
    });
  }
  if (matches.length > 0) {
    console.log(`Deleted ${matches.length} ${label} comment(s) on ${repo}#${pr}`);
  }
  return matches.length;
}

function firstCommentLine(body: string): string {
  return body.trimStart().split(/\r?\n/u, 1)[0]?.trim() ?? "";
}

async function findExistingComment(
  repo: string,
  pr: string,
  token: string,
  marker: string,
  userAgent?: string,
): Promise<GitHubComment | undefined> {
  for (let page = 1; ; page += 1) {
    const comments = await githubApi<GitHubComment[]>(
      `repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`,
      token,
      { userAgent },
    );
    const match = comments.find(
      (comment) =>
        comment.user?.login === "github-actions[bot]" &&
        typeof comment.body === "string" &&
        comment.body.includes(marker),
    );
    if (match) return match;
    if (comments.length < 100) return undefined;
  }
}
