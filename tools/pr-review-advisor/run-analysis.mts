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
  envFile?: string;
};

type RunAnalysisOptions = {
  runGit?: (args: string[], cwd: string) => string;
  runNode?: (script: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => number;
  readText?: (file: string) => string;
  fileExists?: (file: string) => boolean;
  mkdir?: (dir: string) => void;
  writeFile?: (file: string, text: string) => void;
  appendEnv?: (key: string, value: string) => void;
};

const LEGACY_PRIMARY_MODEL = "openai/openai/gpt-5.5";

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
    envFile: env.GITHUB_ENV,
  };
}

function writeBootstrapUnavailableResult(
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
      oneLine: `PR review advisor skipped: ${reason}`,
    },
    findings: [],
    acceptanceCoverage: [],
    securityCategories: [
      {
        category: "Holistic Security Posture",
        verdict: "warning",
        justification: "Advisor bootstrap skip; human review required.",
      },
    ],
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
    `${JSON.stringify({ skipped: true, reason }, null, 2)}\n`,
  );
  options.writeFile(
    path.join(input.outDir, "pr-review-advisor-final-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  options.writeFile(
    path.join(input.outDir, "pr-review-advisor-summary.md"),
    `# ${input.title}\n\nAdvisor analysis skipped.\n\nReason: ${reason}\n`,
  );
}

export function runPrReviewAdvisorAnalysis(
  input = defaultInput(),
  options: RunAnalysisOptions = {},
): void {
  const analyzePath = path.join(input.advisorDir, "tools", "pr-review-advisor", "analyze.mts");
  const schemaPath = path.join(input.advisorDir, "tools", "pr-review-advisor", "schema.json");
  const sessionPath = path.join(input.advisorDir, "tools", "advisors", "session.mts");
  const commentPath = path.join(input.advisorDir, "tools", "pr-review-advisor", "comment.mts");
  const fileExists = options.fileExists ?? fs.existsSync;
  const readText = options.readText ?? ((file: string): string => fs.readFileSync(file, "utf8"));
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
  const appendEnv =
    options.appendEnv ??
    ((key: string, value: string): void => {
      if (!input.envFile) return;
      const fd = fs.openSync(input.envFile, fs.constants.O_WRONLY | fs.constants.O_APPEND);
      try {
        fs.writeFileSync(fd, `${key}=${value}\n`);
      } finally {
        fs.closeSync(fd);
      }
    });

  if (!fileExists(analyzePath)) {
    console.log("Skipping PR review advisor: trusted base checkout does not contain analyze.mts");
    writeBootstrapUnavailableResult(
      input,
      "Trusted base checkout does not contain tools/pr-review-advisor/analyze.mts; advisor will run after the implementation lands on the base branch.",
      {
        mkdir,
        writeFile,
        runGit,
      },
    );
    return;
  }

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
    PR_REVIEW_ADVISOR_RUN_ANALYSIS: input.runAnalysis,
  };
  const trustedTextIncludes = (file: string, text: string): boolean => {
    try {
      return readText(file).includes(text);
    } catch {
      return false;
    }
  };

  if (
    input.model !== LEGACY_PRIMARY_MODEL &&
    (!trustedTextIncludes(sessionPath, input.model) ||
      !trustedTextIncludes(analyzePath, "PR_REVIEW_ADVISOR_MODEL") ||
      !trustedTextIncludes(commentPath, "PR_REVIEW_ADVISOR_COMMENT_MARKER"))
  ) {
    appendEnv("PR_REVIEW_ADVISOR_SUPPORTED", "0");
    console.log(
      `Skipping PR review advisor: trusted base checkout does not yet support ${input.model}`,
    );
    const reason = `Trusted base checkout does not yet support advisor model ${input.model}; this parallel advisor will run after the implementation lands on the base branch.`;
    const code = runNode(
      analyzePath,
      analysisArgs,
      {
        ...inheritedEnv,
        PR_REVIEW_ADVISOR_RUN_ANALYSIS: "0",
        PR_REVIEW_ADVISOR_UNAVAILABLE_REASON: reason,
      },
      input.advisorWorkdir,
    );
    if (code !== 0) {
      throw new RunAnalysisError(
        `PR review advisor unavailable-result generation exited with status ${code}`,
      );
    }
    return;
  }

  appendEnv("PR_REVIEW_ADVISOR_SUPPORTED", "1");
  const code = runNode(analyzePath, analysisArgs, inheritedEnv, input.advisorWorkdir);
  if (code !== 0) throw new RunAnalysisError(`analyze.mts exited with status ${code}`);
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
