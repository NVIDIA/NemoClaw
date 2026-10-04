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

function bashBlockContaining(source: string, marker: string): string {
  const blocks = [...source.matchAll(/^```bash\n([\s\S]*?)^```\s*$/gmu)].map(
    (match) => match[1] ?? "",
  );
  return (
    blocks.find((block) => block.includes(marker)) ??
    (() => {
      throw new Error(`candidate-evidence.md is missing a bash block containing ${marker}`);
    })()
  );
}

const planReadBlock = bashBlockContaining(evidence, 'PLAN_FIELDS="$EVIDENCE_DIR/plan-fields.txt"');
const releaseEntryBlock = bashBlockUnder(evidence, "## Release Entry and Documentation Coverage");
const docsPrSelectionBlock = bashBlockContaining(evidence, 'SELECTED_DOCS_PR="$EVIDENCE_DIR');
const docsPrReadBlock = bashBlockContaining(evidence, 'DOCS_PR_COMMITS="$EVIDENCE_DIR');
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
      CANDIDATE_SELECTION: "current-main",
      EVIDENCE_DIR: input.evidenceDir,
      HISTORICAL_CANDIDATE_EXCEPTION: "None",
      VERSION: version,
    },
  });
}

function selectionFixture() {
  const input = fixture({ "docs/changelog/2026-08-17.mdx": "# Releases\n" });
  const previousTagSha = input.candidate;
  git(input.root, "commit", "--allow-empty", "-m", "docs: merge cumulative documentation");
  const ancestorMergeSha = git(input.root, "rev-parse", "HEAD");
  git(input.root, "commit", "--allow-empty", "-m", "feat: finish release candidate");
  input.candidate = git(input.root, "rev-parse", "HEAD");
  git(input.root, "checkout", "-b", "unrelated", previousTagSha);
  git(input.root, "commit", "--allow-empty", "-m", "docs: unrelated documentation");
  const nonAncestorMergeSha = git(input.root, "rev-parse", "HEAD");
  git(input.root, "checkout", "main");
  return { ancestorMergeSha, input, nonAncestorMergeSha, previousTagSha };
}

function docsCandidate(number: number, mergeSha: string): Record<string, unknown> {
  return {
    headRefName: `automation/post-merge-docs-${number}`,
    headRefOid: String(number).padStart(40, "0"),
    headRepository: { nameWithOwner: "NVIDIA/NemoClaw" },
    mergeCommit: { oid: mergeSha },
    mergedAt: "2026-08-20T12:00:00Z",
    number,
    reviewDecision: "APPROVED",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        conclusion: "SUCCESS",
        name: "docs",
        status: "COMPLETED",
      },
    ],
    title: `docs: prepare v1.2.${number} documentation`,
    url: `https://github.com/NVIDIA/NemoClaw/pull/${number}`,
  };
}

function runDocsPrSelection(
  selection: ReturnType<typeof selectionFixture>,
  candidates: readonly Record<string, unknown>[],
): ReturnType<typeof spawnSync> {
  const { input, previousTagSha } = selection;
  fs.writeFileSync(
    path.join(input.evidenceDir, "managed-docs-pr-candidates.jsonl"),
    candidates
      .map((candidate) => JSON.stringify(candidate))
      .concat("")
      .join("\n"),
  );
  const bin = path.join(input.root, "bin");
  fs.mkdirSync(bin);
  const callLog = path.join(input.evidenceDir, "gh-calls.txt");
  fs.writeFileSync(callLog, "");
  const fakeGh = path.join(bin, "gh");
  fs.writeFileSync(
    fakeGh,
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GH_CALL_LOG"
case "$*" in
  *"/commits?"*) printf '%s\n' "$GH_COMMITS_JSON" ;;
  *"/files?"*) printf '%s\n' "$GH_FILES_JSON" ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  const commitMessage =
    "docs: catch up after main\n\nSigned-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
  return spawnSync("bash", ["-c", `${shellHelpers}\n${docsPrSelectionBlock}\n${docsPrReadBlock}`], {
    cwd: input.root,
    encoding: "utf8",
    env: {
      ...process.env,
      CANDIDATE_SHA: input.candidate,
      EVIDENCE_DIR: input.evidenceDir,
      GH_CALL_LOG: callLog,
      GH_COMMITS_JSON: JSON.stringify([
        [
          {
            sha: "1".repeat(40),
            commit: {
              author: { email: "41898282+github-actions[bot]@users.noreply.github.com" },
              message: "docs: earlier cumulative update",
              verification: { verified: true },
            },
            parents: [{ sha: previousTagSha }],
          },
          {
            sha: String(42).padStart(40, "0"),
            commit: {
              author: { email: "41898282+github-actions[bot]@users.noreply.github.com" },
              message: commitMessage,
              verification: { verified: true },
            },
            parents: [{ sha: previousTagSha }],
          },
        ],
      ]),
      GH_FILES_JSON: JSON.stringify([[{ filename: "docs/guide.mdx" }]]),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PREVIOUS_TAG_SHA: previousTagSha,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("release candidate evidence commands", () => {
  it("uses maintainer-visible coverage instead of an empty-patch receipt", () => {
    expect(evidence).toContain("1. Proceed with the candidate as shown.");
    expect(evidence).toContain("2. Create or update a docs PR for the uncovered range.");
    expect(evidence).toContain("- Maintainer decision: Proceed with the candidate as shown.");
    expect(evidence).not.toContain("approved-empty");
    expect(evidence).not.toContain("Final Documentation Recheck");
  });

  it("accepts the historical plan schema and records its release-entry exception", () => {
    const input = fixture({ "docs/changelog/2026-08-17.mdx": "# Releases\n" });
    const previous = input.candidate;
    git(input.root, "commit", "--allow-empty", "-m", "test: historical candidate");
    const candidate = git(input.root, "rev-parse", "HEAD");
    git(input.root, "commit", "--allow-empty", "-m", "test: current main");
    const originMain = git(input.root, "rev-parse", "HEAD");
    const reason = "Urgent QA qualification requires the preceding main commit.";
    const planPath = path.join(input.root, "plan.json");
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        candidateCommit: candidate,
        candidateSelection: "historical",
        historicalCandidateException: reason,
        nextTag: "v1.2.3",
        originMainCommit: originMain,
        originMainHeadline: "main",
        previousTag: "v1.2.2",
        previousTagCommit: previous,
        previousTagObject: previous,
      }),
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        `${shellHelpers}\nPLAN_PATH="$PLAN_PATH"\n${planReadBlock}\ntrap - EXIT\n${releaseEntryBlock}`,
      ],
      {
        cwd: input.root,
        encoding: "utf8",
        env: { ...process.env, EVIDENCE_DIR: input.evidenceDir, PLAN_PATH: planPath },
      },
    );

    expect(result.status, String(result.stderr)).toBe(0);
    expect(fs.readFileSync(path.join(input.evidenceDir, "release-entry.md"), "utf8").trim()).toBe(
      `Release entry exception: ${reason}`,
    );
  });

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

  it("selects the first ancestor documentation PR and reads only that PR", () => {
    const selection = selectionFixture();
    const result = runDocsPrSelection(selection, [
      docsCandidate(41, selection.nonAncestorMergeSha),
      docsCandidate(42, selection.ancestorMergeSha),
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(
      fs.readFileSync(
        path.join(selection.input.evidenceDir, "selected-docs-pr-fields.tsv"),
        "utf8",
      ),
    ).toContain("42\thttps://github.com/NVIDIA/NemoClaw/pull/42");
    expect(
      fs.readFileSync(path.join(selection.input.evidenceDir, "docs-coverage-sha"), "utf8").trim(),
    ).toBe(selection.previousTagSha);
    const calls = fs.readFileSync(path.join(selection.input.evidenceDir, "gh-calls.txt"), "utf8");
    expect(calls).toContain("/pulls/42/commits");
    expect(calls).toContain("/pulls/42/files");
    expect(calls).not.toContain("/pulls/41/");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(selection.input.evidenceDir, "docs-pr-checks.json"), "utf8"),
      ),
    ).toEqual([
      {
        __typename: "CheckRun",
        conclusion: "SUCCESS",
        name: "docs",
        status: "COMPLETED",
      },
    ]);
    expect(
      fs.readFileSync(path.join(selection.input.evidenceDir, "docs-pr-final-sha"), "utf8").trim(),
    ).toBe(String(42).padStart(40, "0"));
  });

  it("records None and skips selected-PR reads when there are no candidates", () => {
    const selection = selectionFixture();
    const result = runDocsPrSelection(selection, []);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(
      fs
        .readFileSync(path.join(selection.input.evidenceDir, "selected-docs-pr-fields.tsv"), "utf8")
        .trim(),
    ).toBe("None\tNone\tNone\tNone\tNone");
    expect(
      fs.readFileSync(path.join(selection.input.evidenceDir, "docs-coverage-sha"), "utf8").trim(),
    ).toBe(selection.previousTagSha);
    expect(fs.readFileSync(path.join(selection.input.evidenceDir, "gh-calls.txt"), "utf8")).toBe(
      "",
    );
  });

  it("rejects a non-ancestor merged documentation PR without reading it", () => {
    const selection = selectionFixture();
    const result = runDocsPrSelection(selection, [
      docsCandidate(41, selection.nonAncestorMergeSha),
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(
      fs
        .readFileSync(path.join(selection.input.evidenceDir, "selected-docs-pr-fields.tsv"), "utf8")
        .trim(),
    ).toBe("None\tNone\tNone\tNone\tNone");
    expect(
      fs.readFileSync(path.join(selection.input.evidenceDir, "docs-coverage-sha"), "utf8").trim(),
    ).toBe(selection.previousTagSha);
    expect(fs.readFileSync(path.join(selection.input.evidenceDir, "gh-calls.txt"), "utf8")).toBe(
      "",
    );
  });
});
