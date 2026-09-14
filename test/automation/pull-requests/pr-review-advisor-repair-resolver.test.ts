// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  attemptKey,
  type RepairSelection,
} from "../../../tools/pr-review-advisor/repair-contract.mts";
import {
  materializeAdvisorRepairWorkspace,
  prepareAdvisorRepairInputs,
} from "../../../tools/pr-review-advisor/repair-resolve.mts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function selection(sourceHeadSha = "a".repeat(40)): RepairSelection {
  const baseSha = "b".repeat(40);
  const findingIds = ["F-documentation-standard-work-example"];
  const key = attemptKey({
    repository: "NVIDIA/NemoClaw",
    prNumber: 42,
    sourceHeadSha,
    baseSha,
    advisorRunId: 77,
    advisorRunAttempt: 2,
    findingIds,
  });
  return {
    version: 1,
    attemptKey: key,
    repository: "NVIDIA/NemoClaw",
    prNumber: 42,
    sourceHeadSha,
    baseSha,
    headRef: "fix/example",
    repositoryId: "R_repo",
    author: "contributor",
    actor: "maintainer",
    triggeringActor: "maintainer",
    workflowSha: "c".repeat(40),
    advisor: {
      runId: 77,
      runAttempt: 2,
      workflowSha: "d".repeat(40),
      artifactIds: Array.from({ length: 10 }, (_, index) => index + 1),
      ledgerDigest: `sha256:${"e".repeat(64)}`,
    },
    stateDigest: `sha256:${"f".repeat(64)}`,
    reviewDigest: `sha256:${"0".repeat(64)}`,
    findingIds,
    selectedFindings: [
      {
        id: findingIds[0],
        interest: "documentation-standard-work",
        severity: "P1",
        kind: "documentation",
        summary: "The documented command is wrong.",
        path: "docs/example.mdx",
        line: 10,
        impact: "Users run the wrong command.",
        smallestSafeFix: "Correct the command.",
        regressionTest: "Build the documentation.",
        exclusions: [],
      },
    ],
    selectedPaths: ["docs/example.mdx"],
    decisions: [{ id: findingIds[0], selected: true, reason: "eligible" }],
    productScope: "accepted:#10791",
    optIn: "manual-exact-head",
  };
}

describe("PR Review Advisor two-turn resolver", () => {
  it("materializes exact blobs without candidate attributes or symlinks (#10791)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-materialize-"));
    temporaryDirectories.push(directory);
    const repository = path.join(directory, "source");
    fs.mkdirSync(repository);
    const git = (arguments_: string[]) =>
      execFileSync("git", arguments_, {
        cwd: repository,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      })
        .toString("utf8")
        .trim();
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Repair Test"]);
    git(["config", "user.email", "repair@example.test"]);
    fs.mkdirSync(path.join(repository, "docs"));
    fs.writeFileSync(path.join(repository, "docs", "example.mdx"), "before\n");
    fs.writeFileSync(path.join(repository, "script.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(repository, "script.sh"), 0o755);
    fs.symlinkSync("docs/example.mdx", path.join(repository, "link"));
    fs.writeFileSync(path.join(repository, ".gitattributes"), "docs/example.mdx export-subst\n");
    git(["add", "."]);
    git(["commit", "-m", "test: create source tree"]);
    const headSha = git(["rev-parse", "HEAD"]);
    const selectionFile = path.join(directory, "selection.json");
    fs.writeFileSync(selectionFile, JSON.stringify(selection(headSha)));

    const baseDirectory = path.join(directory, "base");
    const workDirectory = path.join(directory, "work");
    materializeAdvisorRepairWorkspace({
      baseDirectory,
      selectionFile,
      sourceRepository: repository,
      workDirectory,
    });

    expect(fs.readFileSync(path.join(baseDirectory, "docs", "example.mdx"), "utf8")).toBe(
      "before\n",
    );
    expect(fs.existsSync(path.join(baseDirectory, "link"))).toBe(false);
    expect(fs.statSync(path.join(baseDirectory, "script.sh")).mode & 0o777).toBe(0o755);
    const materializedWorktree = path.join(workDirectory, "repo");
    expect(fs.readFileSync(path.join(materializedWorktree, "docs", "example.mdx"), "utf8")).toBe(
      "before\n",
    );
    expect(fs.existsSync(path.join(materializedWorktree, "link"))).toBe(false);
    expect(fs.statSync(path.join(materializedWorktree, "script.sh")).mode & 0o777).toBe(0o755);
  });

  it("creates exactly two commit-blind prompts and bounded model input (#10791)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-resolver-"));
    temporaryDirectories.push(directory);
    const selectionFile = path.join(directory, "selection.json");
    const modelContextFile = path.join(directory, "context.json");
    const configDirectory = path.join(directory, "pi-config");
    fs.writeFileSync(selectionFile, JSON.stringify(selection()));
    fs.writeFileSync(
      modelContextFile,
      JSON.stringify({ title: "Correct the documented command." }),
    );

    prepareAdvisorRepairInputs({ selectionFile, modelContextFile, configDirectory });

    expect(fs.readdirSync(configDirectory).sort()).toEqual([
      "models.json",
      "proposal-template.json",
      "repair-input.json",
      "turn-1.txt",
      "turn-2.txt",
    ]);
    expect(fs.readFileSync(path.join(configDirectory, "turn-1.txt"), "utf8")).toContain(
      "Turn 1 of exactly 2",
    );
    expect(fs.readFileSync(path.join(configDirectory, "turn-2.txt"), "utf8")).toContain(
      "Turn 2 of exactly 2",
    );
    const serialized = fs.readFileSync(path.join(configDirectory, "repair-input.json"), "utf8");
    expect(serialized).not.toContain("NVIDIA/NemoClaw");
    expect(serialized).not.toContain("a".repeat(40));
    expect(serialized).not.toContain("sha256:");
  });

  it.each(["9".repeat(40), `sha256:${"9".repeat(64)}`])(
    "rejects unredacted authority identity %s before upload (#10791)",
    (identity) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-resolver-"));
      temporaryDirectories.push(directory);
      const selectionFile = path.join(directory, "selection.json");
      const modelContextFile = path.join(directory, "context.json");
      fs.writeFileSync(selectionFile, JSON.stringify(selection()));
      fs.writeFileSync(modelContextFile, JSON.stringify({ text: identity }));

      expect(() =>
        prepareAdvisorRepairInputs({
          selectionFile,
          modelContextFile,
          configDirectory: path.join(directory, "pi-config"),
        }),
      ).toThrow("revision or digest identity");
    },
  );
});
