// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Repository } from "../src/git.js";

test("analysis excludes its own copied implementation and mapping from discovery and changes", async () => {
  const path = await mkdtemp(join(tmpdir(), "process-window-self-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    await writeFile(join(path, "AGENTS.md"), "Read project guidance.\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "guidance");
    const before = git("rev-parse", "HEAD");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(path, "tools/process-window"), { recursive: true });
    await writeFile(
      join(path, "tools/process-window/prompt.ts"),
      "Recursive prompt must not be analyzed",
    );
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "copy tool");
    const repo = new Repository(path, ["tools/process-window/"]);
    const after = repo.revision("HEAD");
    assert.deepEqual(repo.files(after), ["AGENTS.md"]);
    assert.equal(repo.diff(before, after), "");
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

import { selectRevision, prepareRun } from "../src/ci.js";
import { configSchema } from "../src/model.js";
import { stringify } from "yaml";

test("release selection requires both a matching tag and membership in the configured branch", async () => {
  const path = await mkdtemp(join(tmpdir(), "process-window-release-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    await writeFile(join(path, "AGENTS.md"), "Guidance\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "initial");
    const expected = git("rev-parse", "HEAD");
    git("tag", "v0.1");
    git("tag", "unselected");
    git("checkout", "-qb", "v1");
    await writeFile(join(path, "AGENTS.md"), "Other branch\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-qm", "v1");
    git("tag", "v1.0");
    const config = configSchema.parse({
      repository: { path, url: "https://github.com/example/repo", forge: "github" },
      mapping: "map.yaml",
      output: "site",
      stages: [{ id: "author", name: "Author" }],
      categories: [{ id: "guide", name: "Guide" }],
      branches: [
        {
          id: "main",
          name: "Main",
          ref: "main",
          color: "#123456",
          refresh: { mode: "release", tags: "v0.*" },
        },
      ],
      inference: {
        provider: "openai-compatible",
        baseUrl: "https://example.invalid/v1",
        model: "example",
      },
    });
    const repo = new Repository(path);
    assert.equal(selectRevision(config, repo, "main", "refs/tags/v0.1", true), expected);
    assert.throws(
      () => selectRevision(config, repo, "main", "refs/tags/unselected", true),
      /selector/,
    );
    config.branches[0]!.refresh.tags = "v*";
    assert.throws(() => selectRevision(config, repo, "main", "refs/tags/v1.0", true));
    assert.throws(() => selectRevision(config, repo, "main", "main", true), /release selection/);
    assert.throws(() => selectRevision(config, repo, "unknown"), /Unconfigured/);
    assert.equal(selectRevision(config, repo, "main", expected), expected);
    const cfg = join(path, "config.yaml");
    await writeFile(cfg, stringify(config));
    const prepared = await prepareRun(
      cfg,
      path,
      join(path, "state"),
      join(path, "output"),
      "main",
      expected,
    );
    assert.equal(prepared.selected, true, "Manual analysis overrides refresh policy");
    assert.equal(
      (await prepareRun(cfg, path, path, join(path, "skipped"), "main", expected, "branch"))
        .selected,
      false,
    );
    assert.equal(
      (
        await prepareRun(
          cfg,
          path,
          path,
          join(path, "skipped"),
          "main",
          "refs/tags/unselected",
          "release",
        )
      ).selected,
      false,
    );
    assert.equal(
      (
        await prepareRun(
          cfg,
          path,
          path,
          join(path, "selected"),
          "main",
          "refs/tags/v0.1",
          "release",
        )
      ).selected,
      true,
    );
    await assert.rejects(prepareRun(cfg, path, path, path, "main", "refs/tags/v1.0", "release"));
    config.branches[0]!.refresh.mode = "branch";
    await writeFile(cfg, stringify(config));
    assert.equal(
      (await prepareRun(cfg, path, path, join(path, "selected"), "main", expected, "branch"))
        .selected,
      true,
    );
    assert.equal(
      (
        await prepareRun(
          cfg,
          path,
          path,
          join(path, "skipped"),
          "main",
          "refs/tags/v0.1",
          "release",
        )
      ).selected,
      false,
    );
    config.branches[0]!.refresh.mode = "manual";
    await writeFile(cfg, stringify(config));
    assert.equal(
      (await prepareRun(cfg, path, path, join(path, "skipped"), "main", expected, "branch"))
        .selected,
      false,
    );
    await assert.rejects(
      prepareRun(cfg, path, path, path, "unknown", expected, "branch"),
      /Unconfigured/,
    );
    assert.equal(prepared.revision, expected);
    assert.equal(prepared.config.mapping, join(path, "state", "mapping.yaml"));
    assert.equal(prepared.config.branches[0]!.diffBase, null);
    await mkdir(join(path, "state"));
    await writeFile(
      join(path, "state", "mapping.yaml"),
      stringify({ branches: [{ id: "main", revision: expected }] }),
    );
    const baseline = join(path, "baseline.json");
    await writeFile(baseline, JSON.stringify({ branch: "main", revision: expected }));
    assert.equal(
      (
        await prepareRun(
          cfg,
          path,
          join(path, "state"),
          join(path, "output"),
          "main",
          expected,
          "analyze",
          baseline,
        )
      ).config.branches[0]!.diffBase,
      expected,
    );
    await writeFile(
      join(path, "state", "mapping.yaml"),
      stringify({ branches: [{ id: "main", revision: "a".repeat(40) }] }),
    );
    assert.equal(
      (
        await prepareRun(
          cfg,
          path,
          join(path, "state"),
          join(path, "output"),
          "main",
          expected,
          "analyze",
          baseline,
        )
      ).config.branches[0]!.diffBase,
      null,
      "An unpublished successful artifact must not skip changes since the committed mapping",
    );
    await writeFile(baseline, JSON.stringify({ branch: "v1", revision: expected }));
    assert.equal(
      (
        await prepareRun(
          cfg,
          path,
          join(path, "state"),
          join(path, "output"),
          "main",
          expected,
          "analyze",
          baseline,
        )
      ).config.branches[0]!.diffBase,
      null,
    );
    await assert.rejects(
      prepareRun(cfg, path, path, path, "main", "", "unknown"),
      /Invalid CI mode/,
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

test("refreshes queue together without replacing a pending release or branch run", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  let workflow;
  try {
    workflow = await readFile(new URL("../ci/process-window.yaml", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    workflow = await readFile(
      new URL("../../../.github/workflows/process-window.yaml", import.meta.url),
      "utf8",
    );
  }
  // GitHub owns queue execution; this guards its declarative cross-branch contract.
  const { concurrency } = parse(workflow);
  assert.equal(
    concurrency.group,
    "process-window-${{ github.event_name == 'pull_request' && github.event.pull_request.number || 'refresh' }}",
  );
  assert.equal(concurrency["cancel-in-progress"], false);
  assert.equal(concurrency.queue, "max");
});
