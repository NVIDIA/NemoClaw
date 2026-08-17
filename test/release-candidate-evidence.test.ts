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
const bashBlocks = [...evidence.matchAll(/```bash\n([\s\S]*?)```/gu)].map((match) => match[1]);
const releaseEntryBlock = bashBlocks[1] ?? "";
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

  it("hard-stops remote reads and preserves approved-empty Pi evidence", () => {
    expect(evidence).toContain("PLAN_PATH='../nemoclaw-release-vX.Y.Z/plan.json'");
    expect(evidence).toContain('run_or_stop "release plan read" jq -er');
    expect(evidence).toContain("IFS=$'\\t' read -r VERSION CANDIDATE_SHA");
    expect(evidence).not.toContain("VERSION='vX.Y.Z'");
    expect(evidence).not.toContain("CANDIDATE_SHA='<full-candidate-sha>'");
    expect(evidence).not.toContain("git grep -n -F -x");
    expect(evidence).toContain('git grep -n -E "^## ${VERSION_PATTERN}$"');
    expect(evidence).toContain("'docs/changelog/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].mdx'");
    expect(evidence).not.toMatch(/\$\((?:gh |git ls-remote)/u);
    for (const line of evidence
      .split("\n")
      .filter((value) => /\bgh (?:api|pr|run) /u.test(value))) {
      expect(line.trimStart()).toMatch(/^run_or_stop /u);
    }
    expect(
      evidence
        .split("\n")
        .find((line) => line.includes("git ls-remote --heads origin"))
        ?.trimStart(),
    ).toMatch(/^run_or_stop /u);
    expect(evidence).toContain('--name "$DOCS_ARTIFACT"');
    expect(evidence).toContain('[[ ! -s "$DOCS_PATCH" ]]');
    expect(evidence).toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(evidence).toContain(".mainSha == $sha");
    expect(evidence).toContain("DOCS_REVIEW_JSON");
    expect(evidence).toContain("signed tag annotation");
  });

  it("selects image and Launchable checks before inspecting only their owning run attempts", () => {
    const imageSection = evidence.slice(
      evidence.indexOf("## Image and Launchable Evidence"),
      evidence.indexOf("## Final Documentation Recheck"),
    );
    expect(imageSection.match(/check-runs[?]filter=all&per_page=100/gu)).toHaveLength(1);
    expect(imageSection).toContain("gh api --paginate --slurp");
    expect(imageSection).toContain(
      'select(.name == $name and .status == "completed" and .conclusion == "success")',
    );
    expect(imageSection).toContain('base: successful_check("base-image-publication")');
    expect(imageSection).toContain('launchable: successful_check("Exact staging Brev Launchable")');
    expect(imageSection).toContain("actions/jobs/${BASE_IMAGE_JOB_ID}");
    expect(imageSection).toContain("actions/jobs/${LAUNCHABLE_JOB_ID}");
    expect(imageSection).toContain(
      "[[$baseRun, $baseAttempt], [$launchableRun, $launchableAttempt]] | unique",
    );
    expect(imageSection).not.toContain("gh run view");
    expect(imageSection).toContain("actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}");
    expect(imageSection).toContain('.path == ".github/workflows/e2e.yaml"');
    expect(imageSection).toContain('.head_branch == "main"');
    expect(imageSection).toContain('.event == "workflow_dispatch"');
    expect(imageSection).not.toContain("gh run list");
    expect(imageSection).not.toContain("--limit 100");
    expect(imageSection).toContain("Launchable artifact download");
    expect(imageSection).toContain("Record `ARTIFACT`");
    expect(imageSection).toContain("launchable-e2e.json");
    expect(imageSection).toContain("full-e2e.log");
    expect(imageSection).toContain("grep -Fxq 'NEMOCLAW_FULL_E2E_PASSED'");
    expect(imageSection).toContain("cleanup.json");
    expect(imageSection).toContain(".boot.repoSha == $sha and .boot.provisionSha == $sha");
    expect(imageSection).toContain('.fullE2e == "passed"');
    expect(imageSection).toContain('.status == "ABSENT"');
    expect(imageSection).toContain(".workspaceId == $launchable[0].workspace.id");
    expect(imageSection).toContain("LAUNCHABLE_WORKSPACE_NAME");
    expect(imageSection).toContain("planned candidate still equals `origin/main`");
    expect(imageSection).toContain("cannot create evidence for an older planned candidate");
  });

  it("uses initial and self-contained final candidate documentation checks", () => {
    const finalRecheck = evidence.slice(evidence.indexOf("## Final Documentation Recheck"));
    expect(evidence).not.toContain("Keep this shell open until tag confirmation");
    expect(evidence.match(/gh pr list/gu)).toHaveLength(2);
    expect(evidence.match(/git ls-remote --heads origin/gu)).toHaveLength(2);
    expect(evidence).not.toContain("check_candidate_docs_pending_state");
    expect(finalRecheck).toContain("final release plan read");
    expect(finalRecheck).toContain('"previousTagCommit", "previousTagObject"');
    expect(finalRecheck).toContain(
      'DOCS_BRANCH="automation/post-merge-docs-${CANDIDATE_SHA:0:12}"',
    );
    expect(finalRecheck).toContain("final candidate docs PR read");
    expect(finalRecheck).toContain("final candidate docs branch read");
  });
});
