// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { directDockerfileCopySources } from "../../scripts/lib/dockerfile-copy-sources.mts";

interface PiQualificationReceipt {
  source: {
    cohort: string;
    release: string;
    revision: string;
  };
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PI_DOCKERFILES = ["agents/pi/Dockerfile", "agents/pi/Dockerfile.base"];
const RECEIPT_PATHS = [
  "ci/pi-agent-qualification-v1-linux-amd64.json",
  "ci/pi-agent-qualification-v1-linux-arm64.json",
];

function readReceipt(relativePath: string): PiQualificationReceipt {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function changedPiImageInputs(revision: string): string[] {
  const copiedSources = PI_DOCKERFILES.flatMap((dockerfile) =>
    directDockerfileCopySources(path.join(REPO_ROOT, dockerfile), dockerfile).map(
      ({ source }) => source,
    ),
  );
  const imageSourcePaths = [
    ...new Set([".dockerignore", ...PI_DOCKERFILES, ...copiedSources]),
  ].sort();
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      revision,
      "HEAD",
      "--",
      ...imageSourcePaths,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  return result.stdout.trim().split("\n").filter(Boolean);
}

describe("Pi qualification receipt parity", () => {
  it("keeps both published receipts aligned with every Pi image input", () => {
    const receipts = RECEIPT_PATHS.map(readReceipt);
    const sourceRevisions = new Set(receipts.map(({ source }) => source.revision));
    const sourceCohorts = new Set(receipts.map(({ source }) => source.cohort));
    const sourceReleases = new Set(receipts.map(({ source }) => source.release));

    expect(sourceRevisions.size, "Pi receipts must use one source revision").toBe(1);
    expect(sourceCohorts.size, "Pi receipts must use one publication cohort").toBe(1);
    expect(sourceReleases.size, "Pi receipts must use one release").toBe(1);

    const [sourceRevision] = sourceRevisions;
    const changedInputs = changedPiImageInputs(sourceRevision!);
    expect(
      changedInputs,
      "Pi image inputs changed after the published receipt source. Refresh both architecture receipts from one successful exact-commit Pi candidate cohort.",
    ).toEqual([]);
  });
});
