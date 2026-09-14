// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseAdvisorFindingLedger } from "./finding-ledger.mts";
import {
  assertRepairArtifactDirectory,
  bindRepairSelection,
  positiveInteger,
  readJson,
  repairModelContext,
  type RepairSelection,
} from "./repair-contract.mts";
import { ADVISOR_INTERESTS } from "./specialist-catalog.mts";

type RepairSelectionRequest = Parameters<typeof bindRepairSelection>[0];

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function artifactDirectory(root: string, name: string): string {
  return path.join(root, name);
}

export function selectedAdvisorArtifactIds(
  request: Omit<RepairSelectionRequest, "ledgers">,
): number[] {
  const runId = positiveInteger(request.advisorRun.id, "Advisor run ID");
  const runAttempt = positiveInteger(request.advisorRun.run_attempt, "Advisor run attempt");
  const names = [
    `pr-review-advisor-context-${runId}`,
    ...ADVISOR_INTERESTS.map((interest) => `pr-review-specialist-${interest}-${runAttempt}`),
  ];
  return names
    .map((name) => {
      const matches = request.artifacts.filter((artifact) => artifact.name === name);
      if (
        matches.length !== 1 ||
        matches[0]?.expired !== false ||
        matches[0]?.workflow_run?.id !== runId
      ) {
        throw new Error(`Advisor artifact set is incomplete: ${name}`);
      }
      return positiveInteger(matches[0].id, "Advisor artifact ID");
    })
    .sort((left, right) => left - right);
}

export function bindDownloadedAdvisorRepair(input: {
  artifactDirectory: string;
  outputDirectory: string;
  request: Omit<RepairSelectionRequest, "ledgers">;
}): RepairSelection {
  const runId = positiveInteger(input.request.advisorRun.id, "Advisor run ID");
  const runAttempt = positiveInteger(input.request.advisorRun.run_attempt, "Advisor run attempt");
  assertRepairArtifactDirectory(
    artifactDirectory(input.artifactDirectory, `pr-review-advisor-context-${runId}`),
    { "github-context.json": 5 * 1024 * 1024 },
  );

  const summaries: Record<string, string> = {};
  const ledgers = ADVISOR_INTERESTS.map((interest) => {
    const directory = artifactDirectory(
      input.artifactDirectory,
      `pr-review-specialist-${interest}-${runAttempt}`,
    );
    assertRepairArtifactDirectory(directory, {
      [`pr-review-${interest}-e2e.json`]: 1024 * 1024,
      [`pr-review-${interest}-findings.json`]: 1024 * 1024,
      [`pr-review-${interest}-session.jsonl`]: 10 * 1024 * 1024,
      [`pr-review-${interest}-summary.md`]: 512 * 1024,
      "review-queue-context.json": 1024 * 1024,
    });
    summaries[interest] = readFileSync(
      path.join(directory, `pr-review-${interest}-summary.md`),
      "utf8",
    );
    return parseAdvisorFindingLedger(
      readJson(path.join(directory, `pr-review-${interest}-findings.json`)),
      { headSha: input.request.sourceHeadSha, interest },
    );
  });

  const selection = bindRepairSelection({ ...input.request, ledgers });
  const modelContext = repairModelContext(selection, {
    state: input.request.state,
    reviews: input.request.reviews,
    specialistSummaries: summaries,
  });
  mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(input.outputDirectory, "selection.json"),
    `${JSON.stringify(selection)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    path.join(input.outputDirectory, "model-context.json"),
    `${JSON.stringify(modelContext)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return selection;
}

function main(): void {
  const request = readJson(required(process.env.REQUEST_FILE, "REQUEST_FILE")) as Omit<
    RepairSelectionRequest,
    "ledgers"
  >;
  if (process.argv[2] === "artifact-ids") {
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `artifact-ids=${selectedAdvisorArtifactIds(request).join(",")}\n`,
    );
    return;
  }
  if (process.argv[2] !== "bind") throw new Error("repair selection command is required");
  const selection = bindDownloadedAdvisorRepair({
    artifactDirectory: required(process.env.ADVISOR_ARTIFACT_DIR, "ADVISOR_ARTIFACT_DIR"),
    outputDirectory: required(process.env.OUTPUT_DIR, "OUTPUT_DIR"),
    request,
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `attempt-key=${selection.attemptKey}`,
        `base-sha=${selection.baseSha}`,
        `head-ref=${selection.headRef}`,
        `source-head-sha=${selection.sourceHeadSha}`,
      ].join("\n") + "\n",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
