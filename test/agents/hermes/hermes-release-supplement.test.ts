// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const collector = path.join(
  root,
  ".agents",
  "skills",
  "nemoclaw-contributor-update-dependencies",
  "scripts",
  "collect-hermes-release-supplement.py",
);
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function command(name: "git" | "python3"): string {
  return execFileSync("/usr/bin/env", ["which", name], {
    encoding: "utf8",
  }).trim();
}

function git(repo: string, ...args: string[]): string {
  return execFileSync(command("git"), ["-C", repo, ...args], {
    encoding: "utf8",
  }).trim();
}

function release(tag: string, id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: `2026-07-${String(id).padStart(2, "0")}T00:00:00Z`,
    html_url: `https://github.com/NousResearch/hermes-agent/releases/tag/${tag}`,
    ...overrides,
  };
}

function fixture(): {
  gitExecutable: string;
  releases: string;
  repo: string;
  remoteTagRefs: string;
  output: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-release-supplement-"));
  fixtures.push(directory);
  const repo = path.join(directory, "upstream");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Hermes Test");
  git(repo, "config", "user.email", "hermes-test@example.com");
  // The maintainer checkout signs commits by default. Keep synthetic fixture
  // identities hermetic instead of inheriting an interactive signing agent.
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "tag.gpgsign", "false");

  for (const [index, tag] of ["v2026.7.1", "v2026.7.7", "v2026.7.7.2", "v2026.7.20"].entries()) {
    fs.writeFileSync(path.join(repo, `change-${index}.txt`), `${tag}\n`);
    git(repo, "add", ".");
    git(repo, "commit", "-m", `release ${tag}`);
    git(repo, "tag", "-a", tag, "-m", tag);
  }

  const releases = path.join(directory, "releases.json");
  fs.writeFileSync(
    releases,
    JSON.stringify([
      [release("v2026.7.1", 1), release("v2026.7.7", 7)],
      [
        release("v2026.7.7.1", 8, { draft: true }),
        release("v2026.7.7.2", 9),
        release("v2026.7.20", 20),
      ],
    ]),
  );
  const remoteTagRefs = path.join(directory, "remote-tag-refs.json");
  fs.writeFileSync(
    remoteTagRefs,
    JSON.stringify([
      ["v2026.7.1", "v2026.7.7", "v2026.7.7.2", "v2026.7.20"].map((tag) => ({
        ref: `refs/tags/${tag}`,
        object: {
          type: "tag",
          sha: git(repo, "rev-parse", "--verify", `refs/tags/${tag}`),
        },
      })),
    ]),
  );
  return {
    gitExecutable: command("git"),
    releases,
    repo,
    remoteTagRefs,
    output: path.join(directory, "supplement.json"),
  };
}

function collect(
  testFixture: ReturnType<typeof fixture>,
  overrides: string[] = [],
): ReturnType<typeof spawnSync> {
  return spawnSync(
    command("python3"),
    [
      collector,
      "--repo",
      testFixture.repo,
      "--from",
      "v2026.7.1",
      "--to",
      "v2026.7.20",
      "--releases-json",
      testFixture.releases,
      "--remote-tag-refs-json",
      testFixture.remoteTagRefs,
      "--git-executable",
      testFixture.gitExecutable,
      "--output",
      testFixture.output,
      ...overrides,
    ],
    { encoding: "utf8" },
  );
}

function readReport(filePath: string): { mode: number; text: string } {
  const descriptor = fs.openSync(filePath, "r");
  try {
    return {
      mode: fs.fstatSync(descriptor).mode,
      text: fs.readFileSync(descriptor, "utf8"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

describe("Hermes CalVer release supplement", () => {
  it("retains a published four-component release as an adjacent endpoint", () => {
    const testFixture = fixture();
    const result = collect(testFixture);

    expect(result.status, String(result.stderr ?? "")).toBe(0);
    const report = readReport(testFixture.output);
    expect(report.mode & 0o777).toBe(0o600);
    const supplement = JSON.parse(report.text) as {
      releaseEndpoints: Array<{
        tag: string;
        commitSha: string;
        tagObjectSha: string;
        remoteTagIdentity: {
          provider: string;
          repository: string;
          ref: string;
          rootObjectSha: string;
          rootObjectType: string;
        };
      }>;
      ranges: Array<{
        from: string;
        to: string;
        commitCount: number;
        changedFileCount: number;
      }>;
    };
    expect(supplement.releaseEndpoints.map(({ tag }) => tag)).toEqual([
      "v2026.7.1",
      "v2026.7.7",
      "v2026.7.7.2",
      "v2026.7.20",
    ]);
    expect(
      supplement.releaseEndpoints.every(
        ({ commitSha, tagObjectSha, remoteTagIdentity }) =>
          /^[0-9a-f]{40}$/u.test(commitSha) &&
          /^[0-9a-f]{40}$/u.test(tagObjectSha) &&
          remoteTagIdentity.provider === "github" &&
          remoteTagIdentity.repository === "NousResearch/hermes-agent" &&
          remoteTagIdentity.ref.startsWith("refs/tags/v2026.") &&
          remoteTagIdentity.rootObjectType === "tag" &&
          remoteTagIdentity.rootObjectSha === tagObjectSha,
      ),
    ).toBe(true);
    expect(supplement.ranges).toEqual([
      {
        from: "v2026.7.1",
        to: "v2026.7.7",
        commitCount: 1,
        changedFileCount: 1,
      },
      {
        from: "v2026.7.7",
        to: "v2026.7.7.2",
        commitCount: 1,
        changedFileCount: 1,
      },
      {
        from: "v2026.7.7.2",
        to: "v2026.7.20",
        commitCount: 1,
        changedFileCount: 1,
      },
    ]);
  });

  it("does not replace an existing report", () => {
    const testFixture = fixture();
    fs.writeFileSync(testFixture.output, "keep me\n");

    const result = collect(testFixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to overwrite output path");
    expect(fs.readFileSync(testFixture.output, "utf8")).toBe("keep me\n");
  });

  it("does not follow an existing output symlink", () => {
    const testFixture = fixture();
    const target = path.join(path.dirname(testFixture.output), "target.json");
    fs.writeFileSync(target, "keep me\n");
    fs.symlinkSync(target, testFixture.output);

    const result = collect(testFixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to overwrite output path");
    expect(fs.readFileSync(target, "utf8")).toBe("keep me\n");
    expect(fs.readlinkSync(testFixture.output)).toBe(target);
  });

  it("rejects an output directory writable by other users", () => {
    const testFixture = fixture();
    fs.chmodSync(path.dirname(testFixture.output), 0o777);

    const result = collect(testFixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "output directory must be owned by the current user and not writable by group or other users",
    );
    expect(fs.existsSync(testFixture.output)).toBe(false);
  });

  it("rejects an output directory symlink", () => {
    const testFixture = fixture();
    const target = path.join(path.dirname(testFixture.output), "reports");
    const link = path.join(path.dirname(testFixture.output), "report-link");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link);
    testFixture.output = path.join(link, "supplement.json");

    const result = collect(testFixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not open output directory without following symlinks");
    expect(fs.existsSync(path.join(target, "supplement.json"))).toBe(false);
  });

  it("keeps private mode and removes partial output when fsync fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-private-output-"));
    fixtures.push(directory);
    const secureOutput = path.join(directory, "secure.json");
    const failedOutput = path.join(directory, "failed.json");
    const result = spawnSync(
      command("python3"),
      [
        "-c",
        `
import importlib.util
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("hermes_release_supplement", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

previous_umask = os.umask(0)
try:
    module.write_private_output(Path(sys.argv[2]), "secure\\n")
finally:
    os.umask(previous_umask)

def fail_fsync(_descriptor):
    raise OSError("simulated fsync failure")

module.os.fsync = fail_fsync
try:
    module.write_private_output(Path(sys.argv[3]), "partial\\n")
except OSError as error:
    if str(error) != "simulated fsync failure":
        raise
else:
    raise RuntimeError("expected fsync failure")
`,
        collector,
        secureOutput,
        failedOutput,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, String(result.stderr ?? "")).toBe(0);
    const secureReport = readReport(secureOutput);
    expect(secureReport.mode & 0o777).toBe(0o600);
    expect(secureReport.text).toBe("secure\n");
    expect(fs.existsSync(failedOutput)).toBe(false);
  });

  it("fails when the authoritative stable list omits an endpoint", () => {
    const testFixture = fixture();
    const records = JSON.parse(fs.readFileSync(testFixture.releases, "utf8")) as unknown[][];
    records[1] = records[1].filter(
      (record) => (record as { tag_name?: string }).tag_name !== "v2026.7.20",
    );
    fs.writeFileSync(testFixture.releases, JSON.stringify(records));

    const result = collect(testFixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "authoritative stable release list does not contain 'v2026.7.20'",
    );
  });

  it("rejects a locally recreated annotated tag that differs from GitHub", () => {
    const testFixture = fixture();
    const commitSha = git(
      testFixture.repo,
      "rev-parse",
      "--verify",
      "refs/tags/v2026.7.7.2^{commit}",
    );
    git(testFixture.repo, "tag", "--delete", "v2026.7.7.2");
    git(testFixture.repo, "tag", "-a", "v2026.7.7.2", commitSha, "-m", "locally recreated tag");

    const result = collect(testFixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "local annotated tag object for 'v2026.7.7.2' does not match the authoritative GitHub tag ref",
    );
  });
});
