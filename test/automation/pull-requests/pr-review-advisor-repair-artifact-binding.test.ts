// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAdvisorFindingLedger,
  writeAdvisorFindingLedger,
  type AdvisorFindingLedger,
} from "../../../tools/pr-review-advisor/finding-ledger.mts";
import {
  ADVISOR_INTERESTS,
  type AdvisorInterest,
} from "../../../tools/pr-review-advisor/specialist-catalog.mts";
import {
  parseSelectionInput,
  selectRepairAttempt,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import {
  bindDownloadedAdvisorArtifacts,
  expectedAdvisorArtifactNames,
  parseRepairSelectionAuthority,
  validateAdvisorArtifacts,
} from "../../../tools/pr-review-advisor-repair/select.mts";

let temporaryRoot = "";

afterEach(() => {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
});

function temporaryDirectory(): string {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-artifact-binding-"));
  return temporaryRoot;
}

function write(directory: string, name: string, content: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), content);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function advisorManifest(runId = 700, runAttempt = 2) {
  const workflowSha = "c".repeat(40);
  const names = expectedAdvisorArtifactNames(runId, runAttempt);
  return validateAdvisorArtifacts(
    {
      total_count: names.length,
      artifacts: names.map((name, index) => ({
        id: index + 100,
        name,
        expired: false,
        size_in_bytes: 1024,
        digest: `sha256:${String(index).padStart(64, "0")}`,
        workflow_run: { id: runId, head_sha: workflowSha },
      })),
    },
    { id: runId, attempt: runAttempt, workflowSha },
  );
}

function writeSpecialistArtifact(
  root: string,
  interest: AdvisorInterest,
  ledger: AdvisorFindingLedger,
): string {
  const directory = path.join(root, `pr-review-specialist-${interest}-2`);
  write(directory, `pr-review-${interest}-summary.md`, `Summary for ${interest}.\n`);
  write(directory, `pr-review-${interest}-session.jsonl`, '{"type":"assistant"}\n');
  return writeAdvisorFindingLedger(directory, interest, ledger);
}

describe("PR Review Advisor repair artifact binding", () => {
  it("keeps one-shot identity fixed for the approved head, run, and findings (#10791)", () => {
    const sourceHeadSha = "a".repeat(40);
    const original = selectRepairAttempt(
      parseSelectionInput({
        version: 1,
        repository: "NVIDIA/NemoClaw",
        prNumber: 42,
        pullRequest: {
          state: "open",
          draft: false,
          author: "contributor",
          baseRef: "main",
          headRepository: "NVIDIA/NemoClaw",
          headRef: "fix/demo",
          maintainerCanModify: true,
        },
        sourceHeadSha,
        baseSha: "b".repeat(40),
        advisor: {
          workflowSha: "c".repeat(40),
          runId: 700,
          runAttempt: 2,
          artifactIds: Array.from({ length: 10 }, (_value, index) => index + 100),
          artifactDigests: Array.from(
            { length: 10 },
            (_value, index) => `sha256:${String(index).padStart(64, "0")}`,
          ),
          findingLedgerDigest: `sha256:${"d".repeat(64)}`,
          reviewStateDigest: `sha256:${"e".repeat(64)}`,
        },
        optIn: {
          kind: "phase1-maintainer-dispatch",
          actor: "maintainer",
          triggeringActor: "maintainer",
          headSha: sourceHeadSha,
          findingIds: ["behavior:001"],
        },
        productScope: { kind: "accepted-issue", identity: "#10791" },
        findings: [
          {
            id: "behavior:001",
            repairClass: "source",
            summary: "Repair the selected source behavior.",
            path: "src/demo.ts",
            exclusions: [],
          },
        ],
      }),
    );
    const sameInput = structuredClone(original.input);
    sameInput.advisor.artifactIds = Array.from({ length: 10 }, (_value, index) => index + 900);
    sameInput.advisor.artifactDigests = sameInput.advisor.artifactDigests.map(
      (_digest, index) => `sha256:${String(index + 10).padStart(64, "0")}`,
    );
    sameInput.advisor.findingLedgerDigest = `sha256:${"1".repeat(64)}`;
    sameInput.advisor.reviewStateDigest = `sha256:${"2".repeat(64)}`;
    sameInput.optIn.actor = "another-maintainer";
    sameInput.optIn.triggeringActor = "another-maintainer";
    sameInput.productScope = {
      kind: "maintainer-decision",
      identity: "a differently formatted approval reference",
    };
    sameInput.findings[0]!.path = "src/another-safe-path.ts";

    expect(selectRepairAttempt(parseSelectionInput(sameInput)).attemptKey).toBe(
      original.attemptKey,
    );
    expect(
      selectRepairAttempt(
        parseSelectionInput({
          ...original.input,
          advisor: { ...original.input.advisor, runAttempt: 3 },
        }),
      ).attemptKey,
    ).not.toBe(original.attemptKey);
    expect(
      selectRepairAttempt(
        parseSelectionInput({
          ...original.input,
          optIn: { ...original.input.optIn, findingIds: ["behavior:002"] },
          findings: [{ ...original.input.findings[0], id: "behavior:002" }],
        }),
      ).attemptKey,
    ).not.toBe(original.attemptKey);
  });

  it("validates every bounded artifact file and rejects symlink substitution (#10791)", () => {
    const root = temporaryDirectory();
    const downloadRoot = path.join(root, "downloads");
    fs.mkdirSync(downloadRoot);
    const output = path.join(root, "output", "repair-context.json");
    const sourceHeadSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const manifest = advisorManifest();
    const selectedInterest =
      ADVISOR_INTERESTS.find((interest) => interest.includes("behavior")) ?? ADVISOR_INTERESTS[0]!;
    const ledgers = ADVISOR_INTERESTS.map((interest) =>
      buildAdvisorFindingLedger({
        headSha: sourceHeadSha,
        interest,
        input:
          interest === selectedInterest
            ? {
                findings: [
                  {
                    severity: "P1",
                    kind: "correctness",
                    summary: "Return the normalized value without changing the public contract.",
                    path: "src/demo.ts",
                    line: 1,
                    impact: "The current value is not normalized.",
                    smallestSafeFix: "Normalize the return value at the selected line.",
                    regressionTest: "Add a focused source test for the normalized value.",
                    exclusions: [],
                  },
                ],
                noFindingsReason: null,
              }
            : { findings: [], noFindingsReason: `No ${interest} blocker remains.` },
      }),
    );
    const selectedFindingId = ledgers.find(({ interest }) => interest === selectedInterest)!
      .findings[0]!.id;
    const authority = parseRepairSelectionAuthority({
      version: 1,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      pullRequest: {
        state: "open",
        draft: false,
        author: "contributor",
        baseRef: "main",
        headRepository: "NVIDIA/NemoClaw",
        headRef: "fix/demo",
        maintainerCanModify: true,
      },
      sourceHeadSha,
      baseSha,
      advisor: {
        workflowSha: manifest.run.workflowSha,
        runId: manifest.run.id,
        runAttempt: manifest.run.attempt,
        artifactIds: manifest.artifacts.map(({ id }) => id),
        artifactDigests: manifest.artifacts.map(({ digest }) => digest),
      },
      optIn: {
        kind: "phase1-maintainer-dispatch",
        actor: "maintainer",
        triggeringActor: "maintainer",
        headSha: sourceHeadSha,
        findingIds: [selectedFindingId],
      },
      productScope: { kind: "accepted-issue", identity: "#10791" },
    });
    const contextDirectory = path.join(
      downloadRoot,
      `pr-review-advisor-context-${manifest.run.id}`,
    );
    fs.mkdirSync(contextDirectory);
    writeJson(path.join(contextDirectory, "github-context.json"), {
      repo: "NVIDIA/NemoClaw",
      prNumber: 42,
      pullRequest: {
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: sourceHeadSha, ref: "fix/demo", repo: { full_name: "NVIDIA/NemoClaw" } },
        base: { sha: baseSha, ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },
      },
      reviewState: {
        version: 1,
        repository: "NVIDIA/NemoClaw",
        prNumber: 42,
        headSha: sourceHeadSha,
        issueComments: [],
        reviews: [],
        threads: [],
      },
    });
    const writtenLedgers = ledgers.map((ledger) =>
      writeSpecialistArtifact(downloadRoot, ledger.interest, ledger),
    );
    expect(writtenLedgers.map((file) => fs.existsSync(file))).toEqual(
      ADVISOR_INTERESTS.map(() => true),
    );

    const collected = bindDownloadedAdvisorArtifacts({
      downloadDirectory: downloadRoot,
      outputFile: output,
      authority,
      manifest,
    });
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
      conversation: { turns: 2, persistentMemory: false, commitMetadataVisible: false },
      phase: "phase1-manual-repair",
      selectedFindingIds: [selectedFindingId],
      selectedPaths: ["src/demo.ts"],
    });
    expect(fs.readFileSync(output, "utf8")).not.toContain(collected.selection.attemptKey);

    const selectedSummary = path.join(
      downloadRoot,
      `pr-review-specialist-${selectedInterest}-2`,
      `pr-review-${selectedInterest}-summary.md`,
    );
    fs.rmSync(selectedSummary);
    fs.symlinkSync(path.join(root, "outside.md"), selectedSummary);
    expect(() =>
      bindDownloadedAdvisorArtifacts({
        downloadDirectory: downloadRoot,
        outputFile: path.join(root, "second-context.json"),
        authority,
        manifest,
      }),
    ).toThrow("regular-file contract");

    fs.rmSync(selectedSummary);
    const outsideSummary = path.join(root, "outside-summary.md");
    write(root, "outside-summary.md", "Hard-linked summary.\n");
    fs.linkSync(outsideSummary, selectedSummary);
    expect(() =>
      bindDownloadedAdvisorArtifacts({
        downloadDirectory: downloadRoot,
        outputFile: path.join(root, "third-context.json"),
        authority,
        manifest,
      }),
    ).toThrow("bounded regular file");
  });

  it("rejects missing or extra Advisor artifacts at the runtime boundary (#10791)", () => {
    const run = { id: 700, attempt: 2, workflowSha: "c".repeat(40) };
    const names = expectedAdvisorArtifactNames(run.id, run.attempt);
    const artifacts = names.map((name, index) => ({
      id: index + 100,
      name,
      expired: false,
      size_in_bytes: 1024,
      digest: `sha256:${String(index).padStart(64, "0")}`,
      workflow_run: { id: run.id, head_sha: run.workflowSha },
    }));

    expect(() =>
      validateAdvisorArtifacts(
        { total_count: artifacts.length - 1, artifacts: artifacts.slice(1) },
        run,
      ),
    ).toThrow("exact ten-artifact contract");
    expect(() =>
      validateAdvisorArtifacts(
        {
          total_count: artifacts.length + 1,
          artifacts: [...artifacts, { ...artifacts[0], id: 999, name: "unexpected" }],
        },
        run,
      ),
    ).toThrow("exact ten-artifact contract");
  });
});
