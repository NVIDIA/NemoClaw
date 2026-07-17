// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

type PromptAssetPath = {
  path: string;
};

type PromptAssetRoute = {
  asset: { url: string };
  label: string;
};

export type GitResult = {
  status: number | null;
  stdout: Buffer;
};

export type GitRunner = (args: readonly string[], timeoutMs?: number) => GitResult;

export function createGitRunner(repoRoot: string): GitRunner {
  return (args, timeoutMs = 10_000) => {
    const result = spawnSync("git", [...args], {
      cwd: repoRoot,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return {
      status: result.status,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    };
  };
}

export function resolvePromptAssetRevision(revision: string, git: GitRunner): void {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("promptAssetRevision must be a full lowercase commit SHA");
  }

  let revisionType = git(["cat-file", "-t", revision]);
  if (revisionType.status !== 0) {
    const fetch = git(
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--depth=1",
        "origin",
        revision,
      ],
      120_000,
    );
    if (fetch.status !== 0) {
      throw new Error(`could not fetch immutable prompt asset revision ${revision}`);
    }
    revisionType = git(["cat-file", "-t", revision]);
  }

  if (revisionType.status !== 0) {
    throw new Error(`immutable prompt asset revision ${revision} is unavailable after fetch`);
  }
  const objectType = revisionType.stdout.toString("utf8").trim();
  if (objectType !== "commit") {
    throw new Error(
      `promptAssetRevision must resolve to a commit object, got ${objectType || "no type"}`,
    );
  }
}

export function readPinnedPromptAssetBlob(
  revision: string,
  asset: PromptAssetPath,
  git: GitRunner,
): Buffer {
  const tree = git(["ls-tree", "-z", revision, "--", asset.path]);
  if (tree.status !== 0) {
    throw new Error(`${revision} prompt asset tree could not be read for ${asset.path}`);
  }
  const entry =
    /^(?<mode>100644|100755) blob (?<oid>[0-9a-f]{40}|[0-9a-f]{64})\t(?<path>[^\0]+)\0$/u.exec(
      tree.stdout.toString("utf8"),
    );
  if (!entry?.groups || entry.groups.path !== asset.path) {
    throw new Error(
      `${revision} must contain exactly one regular prompt asset blob at ${asset.path}`,
    );
  }

  const blobType = git(["cat-file", "-t", entry.groups.oid]);
  if (blobType.status !== 0 || blobType.stdout.toString("utf8").trim() !== "blob") {
    throw new Error(`${revision}:${asset.path} does not resolve to a readable Git blob`);
  }
  const blob = git(["cat-file", "blob", entry.groups.oid]);
  if (blob.status !== 0) {
    throw new Error(`could not read immutable prompt asset blob ${revision}:${asset.path}`);
  }
  return blob.stdout;
}

function promptAssetRoutesIn(content: string): Map<string, string> {
  const heading = "## Platform-Specific Instructions\n";
  const headingIndex = content.indexOf(heading);
  if (headingIndex < 0) throw new Error("Missing Platform-Specific Instructions section");
  const bodyStart = headingIndex + heading.length;
  const nextHeading = content.indexOf("\n## ", bodyStart);
  const section = content.slice(bodyStart, nextHeading < 0 ? content.length : nextHeading);
  const routes = new Map<string, string>();

  for (const match of section.matchAll(
    /^- (?<label>[^:\n]+): \[[^\]\n]+\]\((?<url>https?:\/\/[^)\s]+)\)\.$/gmu,
  )) {
    const { label, url } = match.groups ?? {};
    if (!label || !url) throw new Error("Malformed platform prompt asset route");
    if (routes.has(label)) throw new Error(`Duplicate platform prompt asset route for ${label}`);
    routes.set(label, url);
  }
  return routes;
}

export function requireExpectedPromptAssetRoutes(
  content: string,
  expectedRoutes: readonly PromptAssetRoute[],
): Map<string, string> {
  const routes = promptAssetRoutesIn(content);
  if (routes.size !== expectedRoutes.length) {
    throw new Error(
      `Expected ${expectedRoutes.length} platform prompt asset routes, found ${routes.size}`,
    );
  }
  for (const { asset, label } of expectedRoutes) {
    const actualUrl = routes.get(label);
    if (actualUrl !== asset.url) {
      throw new Error(`${label} must map to ${asset.url}, got ${actualUrl ?? "no route"}`);
    }
  }
  return routes;
}
