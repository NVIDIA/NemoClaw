// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";

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
    git("checkout", "-b", "candidate");
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

    const skill = fs.readFileSync(
      path.join(
        import.meta.dirname,
        "../../.agents/skills/nemoclaw-maintainer-security-code-review/SKILL.md",
      ),
      "utf8",
    );
    const procedure = /python3 -I - "\$review_base" <<'PY'\n[\s\S]*?\nPY/.exec(skill);
    assert.ok(procedure, "Security review procedure not found");
    const output = execFileSync("bash", ["-c", procedure[0]], {
      cwd: root,
      env: { ...env, review_base: base },
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
