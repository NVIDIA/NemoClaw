// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertValidatedRepair,
  attemptKey,
  candidateDigest,
  parseValidationReceipt,
  readJson,
  repairValidationPlan,
  type RepairSelection,
  validationReceipt,
} from "../../../tools/pr-review-advisor/repair-contract.mts";
import { reconstructAndSealRepair } from "../../../tools/pr-review-advisor/repair-validate.mts";

const temporaryDirectories: string[] = [];
const git = (repository: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function selection(sourceHeadSha: string): RepairSelection {
  const findingIds = ["F-documentation-standard-work-example"];
  const key = attemptKey({
    repository: "NVIDIA/NemoClaw",
    prNumber: 42,
    sourceHeadSha,
    baseSha: sourceHeadSha,
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
    baseSha: sourceHeadSha,
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

describe("PR Review Advisor trusted validation", () => {
  it("documents candidate execution as a credential-free manual-repair exception (#10791)", () => {
    const readme = fs.readFileSync(
      path.join(process.cwd(), "tools/pr-review-advisor/README.md"),
      "utf8",
    );
    expect(readme).toContain("Normal Advisor review is static analysis only");
    expect(readme).toContain("Manual repair validation is a separate credential-free boundary");
    expect(readme).toContain("PR-derived tests through `npm run test:changed`");
    expect(readme).toContain("remain disabled by `npm ci --ignore-scripts`");
    expect(readme).toContain("records a bounded `blocked`");
    expect(readme).toContain("sandbox-cleanup receipt independently");
  });

  it("reconstructs, runs a secret-free plan, and seals an immutable receipt (#10791)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-validation-test-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const patchRepository = path.join(root, "patch-source");
    const validated = path.join(root, "validated");
    const output = path.join(root, "sealed");
    fs.mkdirSync(source);
    git(source, ["init", "--initial-branch=main"]);
    git(source, ["config", "user.name", "Repair Test"]);
    git(source, ["config", "user.email", "repair@example.test"]);
    fs.mkdirSync(path.join(source, "docs"));
    fs.writeFileSync(path.join(source, "docs/example.mdx"), "before\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "test: add repair source"]);
    const headSha = git(source, ["rev-parse", "HEAD"]);
    execFileSync("git", ["clone", "--quiet", source, patchRepository]);
    fs.writeFileSync(path.join(patchRepository, "docs/example.mdx"), "after\n");
    const patchFile = path.join(root, "repair.patch");
    fs.writeFileSync(
      patchFile,
      execFileSync("git", ["diff", "--binary"], { cwd: patchRepository }),
    );
    const selected = selection(headSha);
    const proposalFile = path.join(root, "proposal.json");
    fs.writeFileSync(
      proposalFile,
      JSON.stringify({
        version: 1,
        findingIds: selected.findingIds,
        unresolvedFindingIds: [],
        changedPaths: selected.selectedPaths,
        summary: "Corrected the documented command.",
        outcome: "proposed",
      }),
    );
    vi.stubEnv("GITHUB_TOKEN", "github-secret");
    vi.stubEnv("OPENAI_API_KEY", "model-secret");
    const environments: NodeJS.ProcessEnv[] = [];

    const candidate = reconstructAndSealRepair({
      selection: selected,
      sourceCheckout: source,
      candidateDirectory: validated,
      patchFile,
      proposalFile,
      outputDirectory: output,
      run: (_executable, _arguments, _workingDirectory, environment) => {
        environments.push(environment);
        return 0;
      },
    });

    expect(environments).toHaveLength(repairValidationPlan(selected).length);
    expect(
      environments.map(({ CI, PATH, GITHUB_TOKEN, OPENAI_API_KEY }) => ({
        CI,
        PATH,
        GITHUB_TOKEN,
        OPENAI_API_KEY,
      })),
    ).toEqual(
      Array.from({ length: environments.length }, () => ({
        CI: "true",
        PATH: process.env.PATH,
        GITHUB_TOKEN: undefined,
        OPENAI_API_KEY: undefined,
      })),
    );
    const receipt = parseValidationReceipt(readJson(path.join(output, "validation.json")));
    expect(() => assertValidatedRepair(selected, receipt, candidate)).not.toThrow();
    expect(fs.readFileSync(path.join(output, "repair.patch"))).toEqual(fs.readFileSync(patchFile));

    fs.writeFileSync(path.join(candidate.repository, "docs/example.mdx"), "mutated\n");
    expect(() =>
      validationReceipt({
        selection: selected,
        candidate,
        candidateDigestAfter: candidateDigest(candidate.repository, selected.sourceHeadSha),
        commands: repairValidationPlan(selected).map(({ command }) => ({ command, exitCode: 0 })),
      }),
    ).toThrow("validation changed");
  });
});
