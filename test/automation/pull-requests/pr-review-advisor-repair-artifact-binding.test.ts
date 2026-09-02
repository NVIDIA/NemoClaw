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
): void {
  const directory = path.join(root, `pr-review-specialist-${interest}-2`);
  write(directory, `pr-review-${interest}-summary.md`, `Summary for ${interest}.\n`);
  write(directory, `pr-review-${interest}-session.jsonl`, '{"type":"assistant"}\n');
  writeAdvisorFindingLedger(directory, interest, ledger);
}

describe("PR Review Advisor repair artifact binding", () => {
  it("validates every bounded artifact file and rejects symlink substitution (#10791)", () => {
    const root = temporaryDirectory();
    const downloadRoot = path.join(root, "downloads");
    fs.mkdirSync(downloadRoot);
    const output = path.join(root, "output", "repair-context.json");
    const sourceHeadSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const manifest = advisorManifest();
    const ledgers = ADVISOR_INTERESTS.map((interest) =>
      buildAdvisorFindingLedger({
        headSha: sourceHeadSha,
        interest,
        input:
          interest === "behavior"
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
    const selectedFindingId = ledgers.find(({ interest }) => interest === "behavior")!.findings[0]!
      .id;
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
    expect(writtenLedgers).toHaveLength(ADVISOR_INTERESTS.length);

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

    const behaviorSummary = path.join(
      downloadRoot,
      "pr-review-specialist-behavior-2",
      "pr-review-behavior-summary.md",
    );
    fs.rmSync(behaviorSummary);
    fs.symlinkSync(path.join(root, "outside.md"), behaviorSummary);
    expect(() =>
      bindDownloadedAdvisorArtifacts({
        downloadDirectory: downloadRoot,
        outputFile: path.join(root, "second-context.json"),
        authority,
        manifest,
      }),
    ).toThrow("regular-file contract");

    fs.rmSync(behaviorSummary);
    const outsideSummary = path.join(root, "outside-summary.md");
    write(root, "outside-summary.md", "Hard-linked summary.\n");
    fs.linkSync(outsideSummary, behaviorSummary);
    expect(() =>
      bindDownloadedAdvisorArtifacts({
        downloadDirectory: downloadRoot,
        outputFile: path.join(root, "third-context.json"),
        authority,
        manifest,
      }),
    ).toThrow("bounded regular file");
  });
});
