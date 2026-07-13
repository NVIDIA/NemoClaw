// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const collector = path.join(
  repoRoot,
  ".agents",
  "skills",
  "nemoclaw-contributor-update-dependencies",
  "scripts",
  "collect-release-ledger.py",
);
const python3 = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo: string, subject: string, contents?: string): string {
  const prepareCommit =
    contents === undefined
      ? () => git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", subject)
      : () => {
          fs.writeFileSync(path.join(repo, "contract.txt"), contents);
          git(repo, "add", "contract.txt");
          git(repo, "-c", "commit.gpgsign=false", "commit", "-m", subject);
        };
  prepareCommit();
  return git(repo, "rev-parse", "HEAD");
}

function createRepository(prefix = "dependency-ledger-security-"): {
  repo: string;
  startSha: string;
  targetSha: string;
} {
  const repo = temporaryDirectory(prefix);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Dependency Security Test");
  git(repo, "config", "user.email", "dependency-security@example.com");
  const startSha = commit(repo, "start contract", "start\n");
  git(repo, "tag", "v1.0.0");
  const targetSha = commit(repo, "target contract", "target\n");
  return { repo, startSha, targetSha };
}

function runCollector(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  return spawnSync(python3, [collector, "--repo", repo, "--from", "v1.0.0", "--to", "HEAD"], {
    encoding: "utf8",
    env,
  });
}

function removePartialCloneConfig(repo: string): void {
  for (const key of [
    "extensions.partialClone",
    "remote.origin.promisor",
    "remote.origin.partialclonefilter",
  ]) {
    spawnSync("git", ["-C", repo, "config", "--unset-all", key], { encoding: "utf8" });
  }
}

function createBloblessClone(): { blobSha: string; repo: string } {
  const { repo: source } = createRepository("dependency-ledger-partial-source-");
  commit(source, "empty target");
  const blobSha = git(source, "rev-parse", "v1.0.0:contract.txt");
  const bare = temporaryDirectory("dependency-ledger-partial-bare-");
  fs.rmSync(bare, { recursive: true });
  execFileSync("git", ["clone", "--bare", source, bare], { stdio: "pipe" });
  git(bare, "config", "uploadpack.allowFilter", "true");
  const repo = temporaryDirectory("dependency-ledger-partial-clone-");
  fs.rmSync(repo, { recursive: true });
  execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", `file://${bare}`, repo], {
    stdio: "pipe",
  });
  return { blobSha, repo };
}

function promisorMarkers(repo: string): string[] {
  const packDirectory = path.join(repo, ".git", "objects", "pack");
  return fs.readdirSync(packDirectory).filter((entry) => entry.endsWith(".promisor"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("dependency release ledger security boundary", () => {
  it("binds --repo despite ambient Git repository and object overrides", () => {
    const selected = createRepository("dependency-ledger-selected-");
    const redirected = createRepository("dependency-ledger-redirected-");
    const redirectedTarget = commit(redirected.repo, "redirected target", "redirected\n");
    const result = runCollector(selected.repo, {
      ...process.env,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(redirected.repo, ".git", "objects"),
      GIT_DIR: path.join(redirected.repo, ".git"),
      GIT_OBJECT_DIRECTORY: path.join(redirected.repo, ".git", "objects"),
      GIT_WORK_TREE: selected.repo,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout as string)).toMatchObject({
      repository: fs.realpathSync(selected.repo),
      target: { sha: selected.targetSha },
    });
    expect(result.stdout).not.toContain(redirectedTarget);
  });

  it("does not let ambient config hide repository clone state", () => {
    const { repo } = createRepository();
    git(repo, "config", "extensions.partialClone", "origin");
    const result = runCollector(repo, {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "extensions.partialClone",
      GIT_CONFIG_VALUE_0: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("configures extensions.partialClone");
    expect(result.stderr).toContain("'origin'");
  });

  it("prevents system, global, and repository config from executing helpers", () => {
    const { repo, targetSha } = createRepository();
    const tree = git(repo, "rev-parse", `${targetSha}^{tree}`);
    const payload = [
      `tree ${tree}`,
      `parent ${targetSha}`,
      "author Signer <signer@example.com> 3 +0000",
      "committer Signer <signer@example.com> 3 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " fake",
      " -----END PGP SIGNATURE-----",
      "",
      "signed target",
      "",
    ].join("\n");
    const signedTarget = execFileSync(
      "git",
      ["-C", repo, "hash-object", "-t", "commit", "-w", "--stdin"],
      { encoding: "utf8", input: payload },
    ).trim();
    git(repo, "update-ref", "refs/heads/main", signedTarget);
    const marker = path.join(temporaryDirectory("dependency-ledger-gpg-marker-"), "executed");
    const helper = path.join(temporaryDirectory("dependency-ledger-gpg-helper-"), "gpg-helper");
    fs.writeFileSync(
      helper,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nprocess.exit(1);\n`,
      { mode: 0o755 },
    );
    const externalConfig = [
      "[core]",
      `\tfsmonitor = ${helper}`,
      `\tpager = ${helper}`,
      "[diff]",
      `\texternal = ${helper}`,
      "[gpg]",
      `\tprogram = ${helper}`,
      "[log]",
      "\tshowSignature = true",
      "",
    ].join("\n");
    const globalConfig = path.join(
      temporaryDirectory("dependency-ledger-global-config-"),
      "gitconfig",
    );
    const systemConfig = path.join(
      temporaryDirectory("dependency-ledger-system-config-"),
      "gitconfig",
    );
    fs.writeFileSync(globalConfig, externalConfig);
    fs.writeFileSync(systemConfig, externalConfig);
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "contract.txt diff=ledger\n");
    git(repo, "config", "core.fsmonitor", helper);
    git(repo, "config", "core.pager", helper);
    git(repo, "config", "diff.external", helper);
    git(repo, "config", "diff.ledger.command", helper);
    git(repo, "config", "diff.ledger.textconv", helper);
    git(repo, "config", "log.showSignature", "true");
    git(repo, "config", "gpg.program", helper);

    const result = runCollector(repo, {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      PAGER: helper,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("bounds every Git subprocess", () => {
    const { repo } = createRepository();
    const bin = temporaryDirectory("dependency-ledger-slow-git-");
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!${process.execPath}\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n`,
      { mode: 0o755 },
    );
    const probe = spawnSync(
      python3,
      [
        "-c",
        [
          "import pathlib, runpy, sys",
          "module = runpy.run_path(sys.argv[1], run_name='ledger_module')",
          "runner = module['run_git']",
          "runner.__globals__['GIT_COMMAND_TIMEOUT_SECONDS'] = 1",
          "try:",
          "    runner(pathlib.Path(sys.argv[2]), 'rev-parse', '--is-inside-work-tree')",
          "except module['LedgerError'] as error:",
          "    print(error)",
          "    raise SystemExit(0)",
          "raise SystemExit(3)",
        ].join("\n"),
        collector,
        repo,
      ],
      { encoding: "utf8", env: { ...process.env, PATH: bin }, timeout: 5_000 },
    );

    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toContain("timed out after 1 seconds");
  });

  it("rejects empty partial-clone markers and invalid promisor settings", () => {
    const { repo } = createRepository();
    git(repo, "config", "extensions.partialClone", "");
    const emptyPartialClone = runCollector(repo);
    expect(emptyPartialClone.status).toBe(1);
    expect(emptyPartialClone.stderr).toContain("extensions.partialClone ('')");
    git(repo, "config", "--unset-all", "extensions.partialClone");

    git(repo, "config", "remote.origin.partialclonefilter", "");
    const emptyFilter = runCollector(repo);
    expect(emptyFilter.status).toBe(1);
    expect(emptyFilter.stderr).toContain("remote partial-clone filters");
    git(repo, "config", "--unset-all", "remote.origin.partialclonefilter");

    git(repo, "config", "remote.origin.promisor", "sometimes");
    const invalidPromisor = runCollector(repo);
    expect(invalidPromisor.status).toBe(1);
    expect(invalidPromisor.stderr).toContain("invalid promisor setting");
  });

  it("rejects repository config includes and fsck policy overrides", () => {
    const { repo } = createRepository();
    const included = path.join(temporaryDirectory("dependency-ledger-included-config-"), "config");
    fs.writeFileSync(included, "[fsck]\n\tmissingEmail = ignore\n");
    git(repo, "config", "include.path", included);
    const includeResult = runCollector(repo);
    expect(includeResult.status).toBe(1);
    expect(includeResult.stderr).toContain("include.path");
    git(repo, "config", "--unset-all", "include.path");

    git(repo, "config", "fsck.missingEmail", "ignore");
    const fsckResult = runCollector(repo);
    expect(fsckResult.status).toBe(1);
    expect(fsckResult.stderr).toContain("fsck.missingemail");
  });

  it("rejects shared alternates and residual promisor packs", () => {
    const { repo: source } = createRepository();
    const shared = temporaryDirectory("dependency-ledger-shared-");
    fs.rmSync(shared, { recursive: true });
    execFileSync("git", ["clone", "--shared", source, shared], { stdio: "pipe" });
    const sharedResult = runCollector(shared);
    expect(sharedResult.status).toBe(1);
    expect(sharedResult.stderr).toContain("alternate object database");

    const partial = createBloblessClone();
    removePartialCloneConfig(partial.repo);
    expect(promisorMarkers(partial.repo).length).toBeGreaterThan(0);
    const residualPromisor = runCollector(partial.repo);
    expect(residualPromisor.status).toBe(1);
    expect(residualPromisor.stderr).toContain("residual promisor pack markers");
  });

  it("rejects missing and corrupt objects anywhere in the reachable closure", () => {
    const partial = createBloblessClone();
    removePartialCloneConfig(partial.repo);
    for (const marker of promisorMarkers(partial.repo)) {
      fs.rmSync(path.join(partial.repo, ".git", "objects", "pack", marker));
    }
    const missing = runCollector(partial.repo);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/reachable object closure|missing objects/u);
    expect(missing.stderr).toContain(partial.blobSha.slice(0, 8));

    const intact = createRepository("dependency-ledger-corrupt-");
    commit(intact.repo, "unchanged target");
    const blobSha = git(intact.repo, "rev-parse", "v1.0.0:contract.txt");
    const objectPath = path.join(
      intact.repo,
      ".git",
      "objects",
      blobSha.slice(0, 2),
      blobSha.slice(2),
    );
    fs.chmodSync(objectPath, 0o644);
    fs.writeFileSync(objectPath, "corrupt object\n");
    const corrupt = runCollector(intact.repo);
    expect(corrupt.status).toBe(1);
    expect(corrupt.stderr).toMatch(/object closure|integrity checks/u);
  });

  it("rejects noncanonical URLs and release URLs bound to another tag", () => {
    const probe = spawnSync(
      python3,
      [
        "-c",
        [
          "import runpy, sys",
          "module = runpy.run_path(sys.argv[1], run_name='ledger_module')",
          "reject = module['LedgerError']",
          "url = module['require_https_url']",
          "release = module['validate_github_release']",
          "identity = {'apiHost': 'github.com', 'fullName': 'Acme/Dependency'}",
          "checks = [('https://github.com/Acme/Dependency;mode=x', '/Acme/Dependency'), ('https://github.com/Acme/%2e%2e/Dependency', '/Acme/Dependency')]",
          "for value, expected in checks:",
          "    try: url(value, 'probe', expected_host='github.com', expected_path=expected)",
          "    except reject: pass",
          "    else: raise SystemExit(3)",
          "payload = {'tag_name': 'v1.0.0', 'id': 1, 'draft': False, 'prerelease': False, 'immutable': True, 'name': 'release', 'target_commitish': 'main', 'published_at': '2026-01-01T00:00:00Z', 'html_url': 'https://github.com/Acme/Dependency/releases/tag/v1.0.1'}",
          "try: release(payload, identity)",
          "except reject: raise SystemExit(0)",
          "raise SystemExit(4)",
        ].join("\n"),
        collector,
      ],
      { encoding: "utf8" },
    );

    expect(probe.status, probe.stderr).toBe(0);
  });
});
