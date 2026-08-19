// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USERNAME_PATTERN = /^(?=.{1,39}$)[a-z\d](?:(?:[a-z\d]|-(?!-))*[a-z\d])?$/;
const UNLIMITED = "unlimited";

export function parsePrLimits(text) {
  const limits = new Map();
  for (const [index, originalLine] of text.split(/\r?\n/u).entries()) {
    const line = originalLine.replace(/\s+#.*$/u, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([^:\s]+)\s*:\s*([^\s]+)$/u.exec(line);
    if (!match) throw new Error(`Invalid PR limit policy at line ${index + 1}`);
    const username = match[1];
    const rawLimit = match[2];
    if (username !== username.toLowerCase() || rawLimit !== rawLimit.toLowerCase())
      throw new Error(`PR limit keys and values must be lowercase at line ${index + 1}`);
    if (username !== "default" && !USERNAME_PATTERN.test(username))
      throw new Error(`Invalid GitHub username at line ${index + 1}: ${match[1]}`);
    if (limits.has(username)) throw new Error(`Duplicate PR limit entry: ${username}`);
    let limit;
    if (rawLimit === UNLIMITED) limit = UNLIMITED;
    else if (/^\d+$/u.test(rawLimit) && Number.isSafeInteger(Number(rawLimit)))
      limit = Number(rawLimit);
    else throw new Error(`Invalid PR limit at line ${index + 1}: ${match[2]}`);
    limits.set(username, limit);
  }
  if (!limits.has("default")) throw new Error("PR limit policy must define default");
  return limits;
}

export function resolvePrLimit(limits, username) {
  const normalized = username.toLowerCase();
  return limits.has(normalized) ? limits.get(normalized) : limits.get("default");
}

export function exceedsPrLimit(limit, openCount) {
  return limit !== UNLIMITED && openCount > limit;
}

async function githubRequest({ token, repository }, route, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "NemoClaw-PR-limit",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok)
    throw new Error(`GitHub API ${options.method ?? "GET"} ${route} failed: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function countOpenPullRequests(context, author) {
  let count = 0;
  for (let page = 1; ; page += 1) {
    const pulls = await githubRequest(context, `/pulls?state=open&per_page=100&page=${page}`);
    count += pulls.filter(
      (pull) => pull.user?.login?.toLowerCase() === author.toLowerCase(),
    ).length;
    if (pulls.length < 100) return count;
  }
}

export async function enforcePrLimit({ policyText, author, pullNumber, repository, token }) {
  const limit = resolvePrLimit(parsePrLimits(policyText), author);
  if (limit === UNLIMITED) {
    console.log(`Author ${author} has an unlimited open PR limit`);
    return { limit, openCount: null, closed: false };
  }
  const context = { repository, token };
  const openCount = await countOpenPullRequests(context, author);
  console.log(`Author ${author} has ${openCount} open PR(s); limit is ${limit}`);
  if (!exceedsPrLimit(limit, openCount)) return { limit, openCount, closed: false };
  const noun = limit === 1 ? "pull request" : "pull requests";
  const body = `This repository limits you to ${limit} open ${noun}. Please close or merge an existing PR before opening another one.`;
  await githubRequest(context, `/issues/${pullNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  await githubRequest(context, `/pulls/${pullNumber}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  throw new Error(`PR closed because ${author} exceeds the ${limit}-open-PR limit`);
}

async function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.INPUT_TOKEN;
  const author = event.pull_request?.user?.login;
  const pullNumber = event.pull_request?.number;
  if (!repository || !token || !author || !pullNumber)
    throw new Error("Missing pull request action context");
  const policyPath = path.join(process.env.GITHUB_WORKSPACE, ".github", "pr-limits.yaml");
  await enforcePrLimit({
    policyText: fs.readFileSync(policyPath, "utf8"),
    author,
    pullNumber,
    repository,
    token,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
