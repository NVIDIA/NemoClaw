// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(
  repoRoot,
  ".agents",
  "skills",
  "nemoclaw-contributor-update-dependencies",
);
const collector = path.join(skillRoot, "scripts", "collect-release-ledger.py");
const temporaryDirectories: string[] = [];

type Ledger = {
  releaseEndpoints: Array<{
    ref: string;
    sha: string;
    tagKind: "annotated" | "lightweight" | null;
    version: string | null;
  }>;
  ranges: Array<{
    from: { ref: string };
    to: { ref: string };
    commitCount: number;
    changedPaths: Array<{ path: string; previousPath?: string; status: string }>;
  }>;
};

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo: string, filename: string, contents: string, subject: string): string {
  fs.writeFileSync(path.join(repo, filename), contents);
  git(repo, "add", "--all");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
}

function createTaggedRepository(): { repo: string; targetSha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-release-ledger-"));
  temporaryDirectories.push(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Dependency Test");
  git(repo, "config", "user.email", "dependency-test@example.com");

  commit(repo, "contract.txt", "one\n", "initial contract");
  git(repo, "tag", "-a", "v1.0.0", "-m", "v1.0.0");
  commit(repo, "contract.txt", "release candidate\n", "prepare release candidate");
  git(repo, "tag", "v1.0.1-rc.1");
  commit(repo, "contract.txt", "stable\n", "stabilize contract");
  git(repo, "tag", "v1.0.1");
  git(repo, "mv", "contract.txt", "renamed-contract.txt");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "rename contract file");
  git(repo, "tag", "-a", "v1.0.2", "-m", "v1.0.2");
  const targetSha = commit(repo, "candidate.txt", "candidate\n", "unreleased candidate");
  return { repo, targetSha };
}

function runCollector(
  repo: string,
  from: string,
  to: string,
  extraArgs: string[] = [],
): SpawnSyncReturns<string> {
  return spawnSync(
    "python3",
    [collector, "--repo", repo, "--from", from, "--to", to, ...extraArgs],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("dependency upgrade skill policy", () => {
  it("requires source-first adjacent-release migration evidence", () => {
    const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    const guide = fs.readFileSync(
      path.join(repoRoot, ".agents", "skills", "nemoclaw-skills-guide", "SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("never collapse the result into one aggregate");
    expect(skill).toContain("Release notes are leads, not proof");
    expect(skill).toContain("Existing green tests only prove what they cover");
    expect(skill).toContain("Inspect test selectors, version gates, conditional skips");
    expect(skill).toContain("Treat matrix flags, environment toggles, and workflow labels");
    expect(skill).toContain("Compare the intended matrix with the observed test IDs and count");
    expect(skill).toContain("never silently audit a stale checkout");
    expect(skill).toContain("An unresolved high-impact concern blocks the version bump");
    expect(skill).toContain("This skill authorizes changes only in NVIDIA/NemoClaw");
    expect(skill).toMatch(/Do not open upstream\s+pull requests or issues/);
    expect(skill).toContain("references/contract-audit.md");
    expect(skill).toContain("scripts/collect-release-ledger.py");
    expect(guide).toContain("`nemoclaw-contributor-update-dependencies`");
  });

  it("requires resolved supply-chain, cache-key, and observed-target evidence", () => {
    const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    const contractAudit = fs.readFileSync(
      path.join(skillRoot, "references", "contract-audit.md"),
      "utf8",
    );

    expect(skill).toContain("Diff resolved dependency graphs, not only top-level manifests");
    expect(skill).toContain("lockfile checksum");
    expect(skill).toContain("Missing notice, SBOM, advisory, or provenance coverage");
    expect(skill).toContain("complete resolved lockfile closure with every shipped notice");
    expect(skill).toContain("UID/GID, user and group names");
    expect(skill).toContain("does not protect same-version configuration changes");
    expect(skill).toContain("machine-readable expected-versus-observed manifest");
    expect(skill).toContain("reject missing, duplicate, skipped, or stale results");
    expect(skill).toContain("Extracting one binary narrows the");
    expect(skill).toContain("does not erase unaudited content in the distributed artifact");
    expect(skill).toContain("mutable bases, unpinned package resolution");
    expect(skill).toContain("build provenance as unresolved reproducibility inputs");
    expect(contractAudit).toContain("| Persisted state and caches |");
    expect(contractAudit).toContain("| Dependency graph |");
    expect(contractAudit).toContain("| Build and image content |");
  });
});

describe("dependency release ledger collector", () => {
  it("emits every adjacent stable range with exact Git evidence", () => {
    const { repo, targetSha } = createTaggedRepository();
    const result = runCollector(repo, "v1.0.0", targetSha);

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(
      ledger.releaseEndpoints.map(({ ref, tagKind, version }) => ({ ref, tagKind, version })),
    ).toEqual([
      { ref: "v1.0.0", tagKind: "annotated", version: "1.0.0" },
      { ref: "v1.0.1", tagKind: "lightweight", version: "1.0.1" },
      { ref: "v1.0.2", tagKind: "annotated", version: "1.0.2" },
      { ref: targetSha, tagKind: null, version: null },
    ]);
    expect(
      ledger.ranges.map(({ from, to, commitCount }) => [from.ref, to.ref, commitCount]),
    ).toEqual([
      ["v1.0.0", "v1.0.1", 2],
      ["v1.0.1", "v1.0.2", 1],
      ["v1.0.2", targetSha, 1],
    ]);
    expect(ledger.ranges[1]?.changedPaths).toContainEqual({
      path: "renamed-contract.txt",
      previousPath: "contract.txt",
      status: "R100",
    });
  });

  it("includes prereleases only when requested and preserves semantic ordering", () => {
    const { repo, targetSha } = createTaggedRepository();
    const withoutPrereleases = runCollector(repo, "v1.0.0", targetSha);
    const withPrereleases = runCollector(repo, "v1.0.0", targetSha, ["--include-prereleases"]);

    expect(withoutPrereleases.status, withoutPrereleases.stderr).toBe(0);
    expect(withPrereleases.status, withPrereleases.stderr).toBe(0);
    expect(
      (JSON.parse(withoutPrereleases.stdout) as Ledger).releaseEndpoints.map(({ ref }) => ref),
    ).not.toContain("v1.0.1-rc.1");
    expect(
      (JSON.parse(withPrereleases.stdout) as Ledger).releaseEndpoints.map(({ ref }) => ref),
    ).toEqual(["v1.0.0", "v1.0.1-rc.1", "v1.0.1", "v1.0.2", targetSha]);
  });

  it("preserves an explicitly targeted prerelease identity without widening the ledger", () => {
    const { repo } = createTaggedRepository();
    const result = runCollector(repo, "v1.0.0", "refs/tags/v1.0.1-rc.1");

    expect(result.status, result.stderr).toBe(0);
    const ledger = JSON.parse(result.stdout) as Ledger;
    expect(
      ledger.releaseEndpoints.map(({ ref, tagKind, version }) => ({ ref, tagKind, version })),
    ).toEqual([
      { ref: "v1.0.0", tagKind: "annotated", version: "1.0.0" },
      { ref: "v1.0.1-rc.1", tagKind: "lightweight", version: "1.0.1-rc.1" },
    ]);
    expect(ledger.ranges).toHaveLength(1);
    expect(ledger.ranges[0]?.to.ref).toBe("v1.0.1-rc.1");
  });

  it("fails closed for missing refs, reversed ancestry, and existing output", () => {
    const { repo, targetSha } = createTaggedRepository();
    const missing = runCollector(repo, "v1.0.0", "missing-ref");
    const reversed = runCollector(repo, "v1.0.2", "v1.0.1");
    const output = path.join(repo, "existing.json");
    fs.writeFileSync(output, "preserve me\n");
    const overwrite = runCollector(repo, "v1.0.0", targetSha, ["--output", output]);

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("missing-ref");
    expect(reversed.status).toBe(1);
    expect(reversed.stderr).toContain("is not an ancestor");
    expect(overwrite.status).toBe(1);
    expect(overwrite.stderr).toContain("refusing to overwrite");
    expect(fs.readFileSync(output, "utf8")).toBe("preserve me\n");
  });

  it("preserves multiple release identities at one target commit deterministically", () => {
    const { repo, targetSha } = createTaggedRepository();
    git(repo, "tag", "v1.0.3", targetSha);
    git(repo, "tag", "v1.0.4", targetSha);

    const first = runCollector(repo, "v1.0.0", targetSha);
    const second = runCollector(repo, "v1.0.0", targetSha);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);

    const ledger = JSON.parse(first.stdout) as Ledger;
    expect(ledger.releaseEndpoints.slice(-2).map(({ ref, sha }) => ({ ref, sha }))).toEqual([
      { ref: "v1.0.3", sha: targetSha },
      { ref: "v1.0.4", sha: targetSha },
    ]);
    expect(ledger.ranges.at(-1)?.commitCount).toBe(0);
  });
});
