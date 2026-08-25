#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type RunAnalysisInput = {
  advisorDir: string;
  advisorWorkdir: string;
  outDir: string;
  baseRef: string;
  headRef: string;
  model: string;
  title: string;
  runAnalysis: string;
};

type RunAnalysisOptions = {
  runGit?: (args: string[], cwd: string) => string;
  runNode?: (script: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => number;
  fileExists?: (file: string) => boolean;
  mkdir?: (dir: string) => void;
  writeFile?: (file: string, text: string) => void;
};

class RunAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunAnalysisError";
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new RunAnalysisError(`${name} is required`);
  return value;
}

function defaultInput(env = process.env): RunAnalysisInput {
  const workspace = required(env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE");
  const artifactDir = required(
    env.PR_REVIEW_ADVISOR_ARTIFACT_DIR,
    "PR_REVIEW_ADVISOR_ARTIFACT_DIR",
  );
  return {
    advisorDir: required(env.ADVISOR_DIR, "ADVISOR_DIR"),
    advisorWorkdir: required(env.ADVISOR_WORKDIR, "ADVISOR_WORKDIR"),
    outDir: path.join(workspace, "artifacts", artifactDir),
    baseRef: required(env.BASE_REF, "BASE_REF"),
    headRef: required(env.HEAD_REF, "HEAD_REF"),
    model: required(env.PR_REVIEW_ADVISOR_MODEL, "PR_REVIEW_ADVISOR_MODEL"),
    title: env.PR_REVIEW_ADVISOR_COMMENT_TITLE || "PR Review Advisor",
    runAnalysis: env.PR_REVIEW_ADVISOR_RUN_ANALYSIS || "1",
  };
}

function writeFailureResult(
  input: RunAnalysisInput,
  reason: string,
  options: Required<Pick<RunAnalysisOptions, "mkdir" | "writeFile" | "runGit">>,
): void {
  options.mkdir(input.outDir);
  let headSha: string;
  try {
    headSha = options.runGit(["rev-parse", input.headRef], input.advisorWorkdir);
  } catch {
    headSha = options.runGit(["rev-parse", "HEAD"], input.advisorWorkdir);
  }
  const result = {
    version: 1,
    baseRef: input.baseRef || "target/base",
    headRef: input.headRef || "HEAD",
    headSha,
    changedFiles: [],
    summary: {
      recommendation: "info_only",
      confidence: "low",
      oneLine: `PR review advisor failed: ${reason}`,
    },
    findings: [],
    terminologyReview: {
      status: "limited",
      decisions: [],
      noChangesReason: reason,
    },
    acceptanceCoverage: [],
    sourceOfTruthReview: [],
    testDepth: { verdict: "unknown", rationale: reason, suggestedTests: [] },
    e2e: {
      coverage: {
        classifiedDomains: [],
        requiredTests: [],
        optionalTests: [],
        newE2eRecommendations: [],
        noE2eReason: reason,
        confidence: "low",
      },
      targets: {
        relevantChangedFiles: [],
        changedCredentialFreeTests: [],
        required: [],
        optional: [],
        noTargetE2eReason: reason,
        confidence: "low",
      },
    },
    positives: [],
    reviewCompleteness: { limitations: [reason], requiresHumanReview: true },
  };
  options.writeFile(
    path.join(input.outDir, "pr-review-advisor-result.json"),
    `${JSON.stringify({ failed: true, reason }, null, 2)}\n`,
  );
  options.writeFile(
    path.join(input.outDir, "pr-review-advisor-final-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  options.writeFile(
    path.join(input.outDir, "pr-review-advisor-summary.md"),
    `# ${input.title}\n\nAdvisor analysis failed.\n\nReason: ${reason}\n`,
  );
}

export function runPrReviewAdvisorAnalysis(
  input = defaultInput(),
  options: RunAnalysisOptions = {},
): void {
  const analyzePath = path.join(input.advisorDir, "tools", "pr-review-advisor", "analyze.mts");
  const schemaPath = path.join(input.advisorDir, "tools", "pr-review-advisor", "schema.json");
  const fileExists = options.fileExists ?? fs.existsSync;
  const mkdir =
    options.mkdir ??
    ((dir: string): void => {
      fs.mkdirSync(dir, { recursive: true });
    });
  const writeFile =
    options.writeFile ??
    ((file: string, text: string): void => {
      const fd = fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      try {
        fs.writeFileSync(fd, text);
      } finally {
        fs.closeSync(fd);
      }
    });
  const runGit =
    options.runGit ??
    ((args: string[], cwd: string): string =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }).trim());
  const runNode =
    options.runNode ??
    ((script: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): number => {
      const result = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
        cwd,
        env,
        stdio: "inherit",
      });
      return result.status ?? 1;
    });
  const analysisArgs = [
    "--base",
    input.baseRef,
    "--head",
    input.headRef,
    "--schema",
    schemaPath,
    "--out-dir",
    input.outDir,
  ];
  const inheritedEnv = {
    ...process.env,
    PR_REVIEW_ADVISOR_MODEL: input.model,
    PR_REVIEW_ADVISOR_RUN_ANALYSIS: input.runAnalysis,
  };
  const code = runNode(analyzePath, analysisArgs, inheritedEnv, input.advisorWorkdir);
  if (code !== 0) {
    const reason = `analyze.mts exited with status ${code}`;
    if (!fileExists(path.join(input.outDir, "pr-review-advisor-final-result.json"))) {
      try {
        const writeMissingFile = (file: string, text: string): void => {
          if (!fileExists(file)) writeFile(file, text);
        };
        writeFailureResult(input, reason, {
          mkdir,
          writeFile: writeMissingFile,
          runGit,
        });
      } catch (error) {
        console.error(
          `Could not complete missing PR review advisor failure artifacts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new RunAnalysisError(reason);
  }
}

function main(): void {
  try {
    runPrReviewAdvisorAnalysis();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
