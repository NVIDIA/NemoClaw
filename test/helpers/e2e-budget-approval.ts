// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { parseE2eAssertionBudget } from "../../scripts/checks/e2e-assertion-census.mts";

/** Bind approval to every budget change, independent of formatting and unrelated base changes. */
export function e2eBudgetChangeDigest(baseSource: string, headSource: string): string | null {
  const base = parseE2eAssertionBudget(baseSource);
  const head = parseE2eAssertionBudget(headSource);
  if (JSON.stringify(base.reference) !== JSON.stringify(head.reference)) return null;
  const changes: [string, number][] = [];
  const add = (key: string, before: number, after: number) => {
    if (before !== after) changes.push([key, after - before]);
  };
  for (const key of ["testFileCount", "liveFileCount"] as const) {
    add(key, base.limits[key], head.limits[key]);
  }
  for (const view of ["direct", "unique"] as const) {
    for (const metric of Object.keys(base.limits[view]) as (keyof typeof base.limits.direct)[]) {
      add(`${view}.${metric}`, base.limits[view][metric], head.limits[view][metric]);
    }
  }
  const files = new Set([...Object.keys(base.limits.files), ...Object.keys(head.limits.files)]);
  for (const file of [...files].sort()) {
    const before = base.limits.files[file];
    const after = head.limits.files[file];
    // Inventory changes remain distinct even when a file has zero assertions.
    add(`files.${file}.present`, before ? 1 : 0, after ? 1 : 0);
    head.limits.fileMetricOrder.forEach((metric, index) => {
      add(`files.${file}.${metric}`, before?.[index] ?? 0, after?.[index] ?? 0);
    });
  }
  changes.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, reference: head.reference, changes }))
    .digest("hex");
}

type Api = (endpoint: string) => unknown;
type Comment = {
  body?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  user?: { login?: unknown; type?: unknown };
};

function githubApi(endpoint: string): unknown {
  return JSON.parse(
    execFileSync("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

/** Read only GitHub-authenticated maintainer records on this PR; never execute candidate content. */
export function hasMaintainerBudgetApproval(
  pr: number,
  digest: string,
  api: Api = githubApi,
): boolean {
  if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Invalid E2E budget approval identity");
  }
  const prefix = "repos/NVIDIA/NemoClaw";
  let approved = false;
  const permissions = new Map<string, boolean>();
  for (let page = 1; page <= 100; page += 1) {
    const comments = api(`${prefix}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error("Could not read E2E budget approval comments");
    for (const value of comments) {
      const comment = value as Comment | null;
      if (!comment || typeof comment.body !== "string" || comment.user?.type !== "User") continue;
      // GitHub preserves the original author when a moderator edits a comment.
      if (
        typeof comment.created_at !== "string" ||
        !Number.isFinite(Date.parse(comment.created_at)) ||
        comment.created_at !== comment.updated_at
      )
        continue;
      const record = comment.body
        .trim()
        .match(/^NemoClaw-E2E-Growth: (approve|revoke) ([a-f0-9]{64})$/);
      if (!record || record[2] !== digest) continue;
      const login = comment.user.login;
      if (typeof login !== "string" || !/^[a-zA-Z0-9-]{1,39}$/.test(login)) continue;
      if (!permissions.has(login)) {
        const result = api(`${prefix}/collaborators/${login}/permission`) as {
          permission?: unknown;
          role_name?: unknown;
        } | null;
        permissions.set(
          login,
          result?.permission === "admin" ||
            (result?.permission === "write" && result.role_name === "maintain"),
        );
      }
      if (permissions.get(login)) approved = record[1] === "approve";
    }
    if (comments.length < 100) return approved;
  }
  throw new Error("E2E budget approval pagination exceeded its limit");
}
