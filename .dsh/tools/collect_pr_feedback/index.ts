// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository))
  throw new Error("Invalid repository");
if (!Number.isSafeInteger(input.pullNumber) || input.pullNumber <= 0)
  throw new Error("Invalid pull number");
const bodyLimit = input.bodyLimit ?? 2000;
if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 100 || bodyLimit > 10000)
  throw new Error("bodyLimit must be between 100 and 10000");
const repo = input.repository;
const pr = input.pullNumber;
const run = async (command, description, allowed = [0]) => {
  const result = await tools.bash({ command, workdir: input.workdir, description });
  if (result.kind !== "foreground" || !allowed.includes(result.exitCode))
    throw new Error(description + " failed");
  if (result.stdout.truncated || result.stderr.truncated)
    throw new Error(description + " exceeded bounded output");
  return result.stdout.text.trim();
};
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const collectPages = async (path, projection, description) => {
  const pageSize = 100;
  const pageLimit = 10;
  const items = [];
  let pages = 0;
  for (let page = 1; page <= pageLimit; page++) {
    const text = await run(
      "gh api " + quote(path + "?per_page=" + pageSize + "&page=" + page),
      description,
    );
    const rows = text ? JSON.parse(text) : [];
    if (!Array.isArray(rows)) throw new Error(description + " returned a non-array response");
    pages++;
    items.push(...rows.map(projection));
    if (rows.length < pageSize) return { items, pages, truncated: false };
  }
  const sentinel = await run(
    "gh api " + quote(path + "?per_page=1&page=" + (pageLimit * pageSize + 1)),
    "Check " + description.toLowerCase() + " completeness",
  );
  const remaining = sentinel ? JSON.parse(sentinel) : [];
  if (!Array.isArray(remaining))
    throw new Error(description + " sentinel returned a non-array response");
  return { items, pages, truncated: remaining.length > 0 };
};
const [pullText, checksText, reviewsPage, inlinePage, discussionPage] = await Promise.all([
  run(
    "gh pr view " +
      pr +
      " --repo " +
      quote(repo) +
      " --json url,state,headRefOid,baseRefOid,mergeStateStatus,reviewDecision",
    "Collect pull request status snapshot",
  ),
  run(
    "gh pr checks " + pr + " --repo " + quote(repo) + " --json name,state,bucket,link",
    "Collect pull request check snapshot",
    [0, 8],
  ),
  collectPages(
    "/repos/" + repo + "/pulls/" + pr + "/reviews",
    (item) => ({
      id: item.id,
      user: item.user?.login ?? "",
      state: item.state ?? "",
      commitId: item.commit_id ?? "",
      body: String(item.body ?? "").slice(0, bodyLimit),
    }),
    "Collect submitted pull request reviews",
  ),
  collectPages(
    "/repos/" + repo + "/pulls/" + pr + "/comments",
    (item) => ({
      id: item.id,
      user: item.user?.login ?? "",
      path: item.path ?? "",
      line: Number.isInteger(item.line) ? item.line : null,
      body: String(item.body ?? "").slice(0, bodyLimit),
      url: item.html_url ?? "",
    }),
    "Collect inline pull request comments",
  ),
  collectPages(
    "/repos/" + repo + "/issues/" + pr + "/comments",
    (item) => ({
      id: item.id,
      user: item.user?.login ?? "",
      body: String(item.body ?? "").slice(0, bodyLimit),
      url: item.html_url ?? "",
    }),
    "Collect pull request discussion comments",
  ),
]);
const pull = pullText ? JSON.parse(pullText) : {};
const checks = checksText ? JSON.parse(checksText) : [];
return {
  pull: {
    url: pull.url ?? "",
    state: pull.state ?? "",
    headRefOid: pull.headRefOid ?? "",
    baseRefOid: pull.baseRefOid ?? "",
    mergeStateStatus: pull.mergeStateStatus ?? "",
    reviewDecision: pull.reviewDecision ?? "",
  },
  checks: checks.map((item) => ({
    name: item.name ?? "",
    state: item.state ?? "",
    bucket: item.bucket ?? "",
    link: item.link ?? "",
  })),
  reviews: reviewsPage.items,
  inlineComments: inlinePage.items,
  discussionComments: discussionPage.items,
  truncation: {
    reviews: reviewsPage.truncated,
    inlineComments: inlinePage.truncated,
    discussionComments: discussionPage.truncated,
  },
};
