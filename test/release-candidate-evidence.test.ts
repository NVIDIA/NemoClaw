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
const releaseSkill = fs.readFileSync(
  path.join(repositoryRoot, ".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md"),
  "utf8",
);
const eveningSkill = fs.readFileSync(
  path.join(repositoryRoot, ".agents/skills/nemoclaw-maintainer-evening/SKILL.md"),
  "utf8",
);

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

function jqProgramFor(source: string, label: string): string {
  const prefix = `run_or_stop "${label}" jq -er '\n`;
  const start = source.indexOf(prefix);
  const requiredStart =
    start !== -1
      ? start
      : (() => {
          throw new Error(`candidate-evidence.md is missing the ${label} jq program`);
        })();
  const programStart = requiredStart + prefix.length;
  const suffix = `\n' "$CHECK_RUNS_FILE"`;
  const end = source.indexOf(suffix, programStart);
  const requiredEnd =
    end !== -1
      ? end
      : (() => {
          throw new Error(`candidate-evidence.md has an incomplete ${label} jq program`);
        })();
  return source.slice(programStart, requiredEnd);
}

const releaseEntryBlock = bashBlockUnder(evidence, "## Release Entry and Pi Result");
const imageCheckSelectionProgram = jqProgramFor(evidence, "image check-run selection");
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

type CheckRun = {
  completed_at: string | null;
  conclusion: string | null;
  created_at: string;
  details_url: string;
  html_url: string;
  id: number;
  name: string;
  started_at: string | null;
  status: string;
};

function checkRun(
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  createdAt: string,
): CheckRun {
  const url = `https://github.com/NVIDIA/NemoClaw/actions/runs/${id}/job/${id + 1000}`;
  return {
    completed_at: status === "completed" ? createdAt : null,
    conclusion,
    created_at: createdAt,
    details_url: url,
    html_url: url,
    id,
    name,
    started_at: status === "queued" ? null : createdAt,
    status,
  };
}

function selectImageChecks(checkRuns: CheckRun[]): ReturnType<typeof spawnSync> {
  return spawnSync("jq", ["-er", imageCheckSelectionProgram], {
    encoding: "utf8",
    input: JSON.stringify([{ check_runs: checkRuns }]),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("release candidate evidence commands", () => {
  it("selects a newer queued Launchable check over an older success", () => {
    const result = selectImageChecks([
      checkRun(10, "base-image-publication", "completed", "success", "2026-08-18T09:00:00Z"),
      checkRun(20, "Exact staging Brev Launchable", "completed", "success", "2026-08-18T09:05:00Z"),
      checkRun(30, "Exact staging Brev Launchable", "queued", null, "2026-08-18T09:10:00Z"),
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(String(result.stdout))).toMatchObject({
      base: { jobId: 1010, status: "completed" },
      launchable: { jobId: 1030, status: "queued" },
    });
  });

  it("uses the check ID to select the newest same-time Launchable status", () => {
    const createdAt = "2026-08-18T09:10:00Z";
    const result = selectImageChecks([
      checkRun(10, "base-image-publication", "completed", "success", "2026-08-18T09:00:00Z"),
      checkRun(30, "Exact staging Brev Launchable", "queued", null, createdAt),
      checkRun(31, "Exact staging Brev Launchable", "completed", "failure", createdAt),
    ]);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(String(result.stdout))).toMatchObject({
      launchable: { conclusion: "failure", jobId: 1031, status: "completed" },
    });
  });

  it("still requires a successful base-image check", () => {
    const result = selectImageChecks([
      checkRun(10, "base-image-publication", "completed", "failure", "2026-08-18T09:00:00Z"),
      checkRun(30, "Exact staging Brev Launchable", "queued", null, "2026-08-18T09:10:00Z"),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "No successful candidate check run named base-image-publication",
    );
  });

  it.each(["BREV_API_KEY", "NEMOCLAW_IMAGE_DISPATCH_TOKEN", "NVIDIA_INFERENCE_API_KEY"])(
    "requires %s remediation when Launchable cleanup is unconfirmed",
    (credential) => {
      expect(releaseSkill).toContain(credential);
    },
  );

  it("requires accountable ownership for deferred Launchable cleanup remediation", () => {
    expect(releaseSkill).toContain("responsible administrator");
    expect(releaseSkill).toContain("remediation deadline");
  });

  it("keeps Launchable status advisory in the evening release handoff", () => {
    expect(eveningSkill).toContain("Treat exact staging Brev Launchable status as E2E context.");
    expect(eveningSkill).not.toContain("staging Brev Launchable E2E and cleanup receipts");
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
});
