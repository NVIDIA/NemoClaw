// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const evidencePath = path.join(
  repositoryRoot,
  ".agents/skills/nemoclaw-maintainer-cut-release-tag/references/candidate-evidence.md",
);
const evidence = fs.readFileSync(evidencePath, "utf8");

function bashBlockUnder(source: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const block = new RegExp(
    `^${escapedHeading}\\n(?:(?!^## |^\`\`\`)[\\s\\S])*^\`\`\`bash\\n([\\s\\S]*?)^\`\`\`\\s*$`,
    "mu",
  ).exec(source)?.[1];
  return (
    block ??
    (() => {
      throw new Error(`candidate-evidence.md is missing a bash block under ${heading}`);
    })()
  );
}

const releaseEntryBlock = bashBlockUnder(evidence, "## Release Entry and Pi Result");
const temporaryDirectories: string[] = [];

const shellHelpers = String.raw`
set -euo pipefail
run_or_stop() {
  local label="$1"
  local status
  shift
  if "$@"; then
    return 0
  else
    status=$?
    printf '%s failed with status %s\n' "$label" "$status" >&2
    exit "$status"
  fi
}
stop() {
  printf '%s\n' "$1" >&2
  exit 1
}
`;

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function fixture(contents: Record<string, string>): {
  candidate: string;
  evidenceDir: string;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-candidate-evidence-"));
  temporaryDirectories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "commit.gpgsign", "false");
  for (const [file, content] of Object.entries(contents)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(root, "add", ".");
  git(root, "commit", "-m", "docs: add changelog fixture");
  const evidenceDir = path.join(root, "evidence");
  fs.mkdirSync(evidenceDir);
  return { candidate: git(root, "rev-parse", "HEAD"), evidenceDir, root };
}

function runReleaseEntry(
  input: ReturnType<typeof fixture>,
  version = "v1.2.3",
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-c", `${shellHelpers}\n${releaseEntryBlock}`], {
    cwd: input.root,
    encoding: "utf8",
    env: {
      ...process.env,
      CANDIDATE_SHA: input.candidate,
      EVIDENCE_DIR: input.evidenceDir,
      VERSION: version,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("release candidate evidence commands", () => {
  it("extracts only the exact release H2 section from a multi-entry changelog", () => {
    const input = fixture({
      "docs/changelog/2026-08-17.mdx": [
        "# Releases",
        "",
        "## v1.2.3",
        "",
        "- Current release.",
        "",
        "### Detail",
        "",
        "Still current.",
        "",
        "## v1.2.2",
        "",
        "Previous release.",
        "",
      ].join("\n"),
      "docs/changelog/2026-08-16.mdx": "# Releases\n\n## v1.2.1\n\nOlder release.\n",
      "docs/changelog/overview.mdx": "# Releases\n\n## v1.2.3\n\n- Not a dated entry.\n",
    });

    const result = runReleaseEntry(input);

    expect(result.status, String(result.stderr)).toBe(0);
    const entry = fs.readFileSync(path.join(input.evidenceDir, "release-entry.md"), "utf8");
    expect(entry.trim()).toBe(
      ["## v1.2.3", "", "- Current release.", "", "### Detail", "", "Still current."].join("\n"),
    );
    expect(entry).not.toContain("v1.2.2");
    expect(entry).not.toContain("Previous release");
  });

  it("stops when the exact release heading appears more than once", () => {
    const input = fixture({
      "docs/changelog/2026-08-17.mdx": "# Releases\n\n## v1.2.3\n\nOne.\n",
      "docs/changelog/2026-08-18.mdx": "# Releases\n\n## v1.2.3\n\nTwo.\n",
    });

    const result = runReleaseEntry(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected one release entry; found 2");
  });

  it("stops when the release entry has no detailed bullet", () => {
    const input = fixture({
      "docs/changelog/2026-08-17.mdx": "# Releases\n\n## v1.2.3\n",
    });

    const result = runReleaseEntry(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release-entry detail validation failed");
  });
});
