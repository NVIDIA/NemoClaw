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

export async function githubApi<T>(
  apiPath: string,
  token: string,
  options: GitHubRequestOptions = {},
): Promise<T> {
  // lgtm[js/file-access-to-http] Advisor workflows intentionally send normalized
  // artifact summaries and strictly validated dispatch inputs to GitHub APIs.
  // Callers construct apiPath from fixed workflow/comment endpoints, not PR text.
  const response = await fetch(`https://api.github.com/${apiPath}`, {
    method: options.method || "GET",
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
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${apiPath} failed: ${response.status} ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
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
