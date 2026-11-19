// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";

function reviewProcedures() {
  const skill = fs.readFileSync(
    path.join(
      import.meta.dirname,
      "../../.agents/skills/nemoclaw-maintainer-security-code-review/SKILL.md",
    ),
    "utf8",
  );
  const selection = /```bash\n(review_base=[\s\S]*?)\n```/.exec(skill);
  const procedure = /python3 -I - "\$review_base" <<'PY'\n[\s\S]*?\nPY/.exec(skill);
  assert.ok(selection, "Base selection procedure not found");
  assert.ok(procedure, "Security review procedure not found");
  return { selection: selection[1], procedure: procedure[0] };
}

function reviewCommand() {
  const { selection, procedure } = reviewProcedures();
  return (
    'gh() { test "$*" = "pr view 123 --json baseRefOid -q .baseRefOid" || return 1; printf "%s\\n" "$fixture_base_oid"; }\n' +
    selection.replace("<number>", "123") +
    "\n" +
    procedure
  );
}

it.each([
  ["[x].txt", "main", "unrelated"],
  ["a;touch marker;#", "main", "unrelated"],
  ["quote'\"\n$(touch marker)", "main", "unrelated"],
  ["-option", "main", "unrelated"],
  ["release.txt", "release/security", "main"],
])(
  "reviews %s against %s without executing shell or diff helpers",
  (name, base, unrelatedBranch) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-review-paths-"));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = {
      HOME: root,
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      PYTHONPATH: root,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, env, encoding: "utf8" });
    git("init", "-b", base);
    fs.writeFileSync(path.join(root, "old.txt"), "target-content\n");
    git("add", "--all");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
    const baseOid = git("rev-parse", "HEAD").trim();
    git("update-ref", `refs/remotes/origin/${base}`, baseOid);
    git("checkout", "-b", "candidate");
    git("branch", "-D", base);
    fs.renameSync(path.join(root, "old.txt"), path.join(root, name));
    fs.writeFileSync(path.join(root, "x.txt"), "sibling-content\n");
    git("add", "--all");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixtures");
    // Selecting the unrelated branch must omit the candidate change.
    git("branch", "-f", unrelatedBranch, "HEAD");
    git("config", "diff.external", "touch external-marker");
    fs.writeFileSync(path.join(root, ".gitattributes"), "*.txt diff=fixture\n");
    git("config", "diff.fixture.textconv", "touch textconv-marker");
    fs.writeFileSync(
      path.join(root, "subprocess.py"),
      'open("python-marker", "w").close()\nraise RuntimeError("checkout module imported")\n',
    );

    const output = execFileSync("bash", ["-c", reviewCommand()], {
      cwd: root,
      env: { ...env, fixture_base_oid: baseOid },
      encoding: "utf8",
    });
    expect(output.split("+target-content\n")).toHaveLength(2);
    expect(output.split("-target-content\n")).toHaveLength(2);
    expect(output.split("+sibling-content\n")).toHaveLength(2);
    expect(fs.existsSync(path.join(root, "marker"))).toBe(false);
    expect(fs.existsSync(path.join(root, "external-marker"))).toBe(false);
    expect(fs.existsSync(path.join(root, "textconv-marker"))).toBe(false);
    expect(fs.existsSync(path.join(root, "python-marker"))).toBe(false);
  },
);

it("stops before diffing when the PR base commit is unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-review-missing-base-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TRACE: path.join(root, "git.trace"),
    fixture_base_oid: "0".repeat(40),
  };
  execFileSync("git", ["init", "-b", "main"], { cwd: root, env });
  const result = spawnSync("bash", ["-c", reviewCommand()], { cwd: root, env, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Base commit unavailable. Fetch the PR base branch");
  expect(result.stdout).toBe("");
  expect(fs.readFileSync(env.GIT_TRACE, "utf8")).not.toContain("git diff");
});

it("renders submodule pointers without executing nested diff helpers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-review-submodule-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    HOME: root,
    TMPDIR: root,
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8" });
  git("init", "-b", "main");
  const child = path.join(root, "child");
  fs.mkdirSync(child);
  git("-C", child, "init", "-b", "main");
  fs.writeFileSync(path.join(child, "a.txt"), "before\n");
  fs.writeFileSync(path.join(child, ".gitattributes"), "*.txt diff=fixture\n");
  git("-C", child, "add", "--all");
  git("-C", child, "-c", "core.hooksPath=/dev/null", "commit", "-m", "child base");
  const childBase = git("-C", child, "rev-parse", "HEAD").trim();
  git("update-index", "--add", "--cacheinfo", `160000,${childBase},child`);
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "base");
  const baseOid = git("rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(child, "a.txt"), "after\n");
  fs.writeFileSync(path.join(child, "helper.sh"), "#!/bin/sh\ntouch nested-helper-marker\n", {
    mode: 0o755,
  });
  git("-C", child, "add", "--all");
  git("-C", child, "-c", "core.hooksPath=/dev/null", "commit", "-m", "child candidate");
  const childCandidate = git("-C", child, "rev-parse", "HEAD").trim();
  git("update-index", "--cacheinfo", `160000,${childCandidate},child`);
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "candidate");
  fs.writeFileSync(path.join(child, "a.txt"), "later checkout\n");
  git("-C", child, "add", "a.txt");
  git("-C", child, "-c", "core.hooksPath=/dev/null", "commit", "-m", "later child checkout");
  git("config", "diff.submodule", "diff");
  git("config", "diff.ignoreSubmodules", "all");
  git("-C", child, "config", "diff.external", "./helper.sh");
  git("-C", child, "config", "diff.fixture.textconv", "./helper.sh");
  const output = execFileSync("bash", ["-c", reviewCommand()], {
    cwd: root,
    env: { ...env, fixture_base_oid: baseOid },
    encoding: "utf8",
  });
  expect(fs.existsSync(path.join(child, "nested-helper-marker"))).toBe(false);
  expect(output).toContain(`-Subproject commit ${childBase}`);
  expect(output).toContain(`+Subproject commit ${childCandidate}`);
  const childCommand = reviewProcedures().procedure.replace(
    '"$review_base"',
    '"$old_gitlink" "$new_gitlink"',
  );
  const childOutput = execFileSync("bash", ["-c", childCommand], {
    cwd: child,
    env: { ...env, old_gitlink: childBase, new_gitlink: childCandidate },
    encoding: "utf8",
  });
  expect(childOutput).toContain("-before\n");
  expect(childOutput).toContain("+after\n");
  expect(childOutput).not.toContain("later checkout");
  expect(fs.existsSync(path.join(child, "nested-helper-marker"))).toBe(false);
});
