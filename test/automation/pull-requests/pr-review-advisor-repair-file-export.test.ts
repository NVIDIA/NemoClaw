// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  fixtureGit as git,
  repairSelectionInput,
  writeFixture as write,
} from "../../helpers/pr-review-advisor-repair.ts";

import {
  parseSelectionInput,
  selectRepairAttempt,
  type FindingInput,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import { exportTrustedRepairPatch } from "../../../tools/pr-review-advisor-repair/resolve.mts";
import { validateRepairLocally } from "../../../tools/pr-review-advisor-repair/validate.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-repair-export-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function selectionInput(
  findings: FindingInput[],
  findingIds: string[],
  sourceHeadSha = "a".repeat(40),
  baseSha = "b".repeat(40),
): Record<string, unknown> {
  return repairSelectionInput({
    findings,
    sourceHeadSha,
    baseSha,
    optIn: { headSha: sourceHeadSha, findingIds },
  });
}

afterEach(() => {
  temporaryDirectories
    .splice(0)
    .forEach((directory) => fs.rmSync(directory, { force: true, recursive: true }));
});

describe("PR Review Advisor repair file export", () => {
  it("orders finding identities and selected paths by canonical code units (#10791)", () => {
    const bundle = selectRepairAttempt(
      parseSelectionInput(
        selectionInput(
          [
            {
              id: "a:001",
              repairClass: "source",
              summary: "Update the lower-case finding.",
              path: "src/z.ts",
              exclusions: [],
            },
            {
              id: "B:001",
              repairClass: "source",
              summary: "Update the upper-case finding.",
              path: "src/A.ts",
              exclusions: [],
            },
          ],
          ["B:001", "a:001"],
        ),
      ),
    );

    expect(bundle.selectedFindingIds).toEqual(["B:001", "a:001"]);
    expect(bundle.selectedPaths).toEqual(["src/A.ts", "src/z.ts"]);
    expect(bundle.decisions.map(({ id }) => id)).toEqual(["B:001", "a:001"]);
  });

  it("exports and validates a newly created selected source file (#10791)", () => {
    const repository = temporaryDirectory();
    git(repository, ["init", "--initial-branch=main"]);
    git(repository, ["config", "user.name", "Advisor Repair Test"]);
    git(repository, ["config", "user.email", "advisor-repair@example.test"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    write(repository, "src/existing.ts", "export const existing = true;\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "test: add repair fixture"]);
    const sourceHeadSha = git(repository, ["rev-parse", "HEAD"]);
    const bundle = selectRepairAttempt(
      parseSelectionInput(
        selectionInput(
          [
            {
              id: "behavior:new",
              repairClass: "source",
              summary: "Add the missing source implementation.",
              path: "src/new.ts",
              exclusions: [],
            },
          ],
          ["behavior:new"],
          sourceHeadSha,
          sourceHeadSha,
        ),
      ),
    );
    const root = temporaryDirectory();
    const baseline = path.join(root, "baseline");
    fs.cpSync(repository, baseline, {
      recursive: true,
      filter: (source) => path.basename(source) !== ".git",
    });
    const candidate = path.join(root, "candidate");
    fs.cpSync(baseline, candidate, { recursive: true });
    write(candidate, "src/new.ts", "export const added = true;\n");
    const selectionFile = path.join(root, "selection.json");
    const proposalFile = path.join(root, "proposal.json");
    fs.writeFileSync(selectionFile, `${JSON.stringify(bundle)}\n`);
    fs.writeFileSync(
      proposalFile,
      `${JSON.stringify({
        version: 1,
        findingIds: bundle.selectedFindingIds,
        unresolvedFindingIds: [],
        changedPaths: ["src/new.ts"],
        summary: "Added the selected implementation.",
        outcome: "proposed",
      })}\n`,
    );
    const artifactDirectory = path.join(root, "artifact");
    exportTrustedRepairPatch({
      sourceCheckout: repository,
      baselineExport: baseline,
      candidateRepository: candidate,
      proposalFile,
      selectionFile,
      artifactDirectory,
      stagingDirectory: path.join(root, "export-staging"),
    });

    const patch = fs.readFileSync(path.join(artifactDirectory, "repair.patch"), "utf8");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("+++ b/src/new.ts");
    const result = validateRepairLocally({
      sourceCheckout: repository,
      selection: bundle,
      patchFile: path.join(artifactDirectory, "repair.patch"),
      proposalFile: path.join(artifactDirectory, "proposal.json"),
      stagingDirectory: path.join(root, "validation-staging"),
      commandRunner: () => ({ argv: ["validated"], exitCode: 0 }),
    });
    expect(result.receipt.changedPaths).toEqual([
      {
        path: "src/new.ts",
        status: "A",
        mode: "100644",
        type: "blob",
        bytes: Buffer.byteLength("export const added = true;\n"),
      },
    ]);
  });
});
