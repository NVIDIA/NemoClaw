#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { githubApi } from "../advisors/github.mts";
import {
  CANONICAL_REPOSITORY,
  githubLogin,
  readBoundedJson,
  RepairContractError,
  sanitizeDiagnostic,
} from "./contract.mts";
import { TRUSTED_GENERATED_HEAD_REF } from "./generated-head-validation.mts";

type GitHubRequest = <T>(apiPath: string, token: string) => Promise<T>;

type PullRequest = {
  number?: unknown;
  state?: unknown;
  draft?: unknown;
  maintainer_can_modify?: unknown;
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown };
  head?: { sha?: unknown; repo?: { full_name?: unknown } };
  base?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } };
};

export type GeneratedHeadContext = {
  version: 1;
  repository: typeof CANONICAL_REPOSITORY;
  prNumber: number;
  sourceHeadSha: string;
  baseSha: string;
  repairAttemptKey: string;
  title: string;
  body: string;
  author: string;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new RepairContractError(`${name} is required`);
  return value;
}

function fullSha(value: string, name: string): string {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new RepairContractError(`${name} must be a full SHA`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new RepairContractError(`${name} must be positive`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RepairContractError(`${name} must be safe`);
  return parsed;
}

function boundedText(
  value: unknown,
  name: string,
  maximum: number,
  allowLineBreaks = false,
): string {
  const forbidden = allowLineBreaks
    ? /[\u0000\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximum ||
    forbidden.test(value)
  ) {
    throw new RepairContractError(`${name} must be bounded text`);
  }
  return value;
}

export async function collectGeneratedHeadContext(
  env: NodeJS.ProcessEnv,
  request: GitHubRequest = githubApi,
): Promise<GeneratedHeadContext> {
  if (required(env, "GITHUB_EVENT_NAME") !== "workflow_dispatch") {
    throw new RepairContractError("generated-head context requires workflow_dispatch");
  }
  if (required(env, "GITHUB_REPOSITORY") !== CANONICAL_REPOSITORY) {
    throw new RepairContractError("generated-head validation requires the canonical repository");
  }
  const prNumber = positiveInteger(required(env, "PR_NUMBER"), "PR_NUMBER");
  const sourceHeadSha = fullSha(required(env, "SOURCE_HEAD_SHA"), "SOURCE_HEAD_SHA");
  const baseSha = fullSha(required(env, "BASE_SHA"), "BASE_SHA");
  const workflowHeadSha = fullSha(required(env, "GITHUB_SHA"), "GITHUB_SHA");
  const workflowDefinitionSha = fullSha(
    required(env, "GITHUB_WORKFLOW_SHA"),
    "GITHUB_WORKFLOW_SHA",
  );
  const repairAttemptKey = required(env, "REPAIR_ATTEMPT_KEY");
  if (!/^sha256:[0-9a-f]{64}$/u.test(repairAttemptKey)) {
    throw new RepairContractError("REPAIR_ATTEMPT_KEY is malformed");
  }
  if (required(env, "GITHUB_REF") !== `refs/heads/${TRUSTED_GENERATED_HEAD_REF}`) {
    throw new RepairContractError("generated-head workflow was not dispatched from trusted main");
  }
  if (workflowHeadSha !== workflowDefinitionSha) {
    throw new RepairContractError(
      "generated-head workflow is not executing one exact trusted workflow revision",
    );
  }

  const pull = await request<PullRequest>(
    `repos/${CANONICAL_REPOSITORY}/pulls/${prNumber}`,
    required(env, "GITHUB_TOKEN"),
  );
  if (
    pull.number !== prNumber ||
    pull.state !== "open" ||
    pull.draft !== false ||
    pull.maintainer_can_modify !== true ||
    pull.head?.sha !== sourceHeadSha ||
    pull.head?.repo?.full_name !== CANONICAL_REPOSITORY ||
    pull.base?.sha !== baseSha ||
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== CANONICAL_REPOSITORY
  ) {
    throw new RepairContractError("live pull request no longer matches generated-head dispatch");
  }
  const author = githubLogin(pull.user?.login, "pull request author");
  return {
    version: 1,
    repository: CANONICAL_REPOSITORY,
    prNumber,
    sourceHeadSha,
    baseSha,
    repairAttemptKey,
    title: boundedText(pull.title, "pull request title", 512),
    body: boundedText(pull.body ?? "", "pull request body", 128 * 1024, true),
    author,
  };
}

function parseContext(file: string): GeneratedHeadContext {
  const value = readBoundedJson(file, 256 * 1024) as Partial<GeneratedHeadContext>;
  if (
    value.version !== 1 ||
    value.repository !== CANONICAL_REPOSITORY ||
    !Number.isSafeInteger(value.prNumber) ||
    typeof value.sourceHeadSha !== "string" ||
    typeof value.baseSha !== "string" ||
    typeof value.repairAttemptKey !== "string" ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.author !== "string"
  ) {
    throw new RepairContractError("generated-head context is malformed");
  }
  return value as GeneratedHeadContext;
}

export function assertDcoDeclaration(context: GeneratedHeadContext): void {
  if (["dependabot[bot]", "app/dependabot"].includes(context.author)) return;
  const normalized = context.body.replace(/\r/gu, "");
  if (!/^Signed-off-by:\s+.+\s+<[^<>]+>$/mu.test(normalized)) {
    throw new RepairContractError("PR description must contain a valid Signed-off-by declaration");
  }
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const command = required(env, "GENERATED_HEAD_COMMAND");
  const contextFile = required(env, "GENERATED_HEAD_CONTEXT_FILE");
  if (command === "verify") {
    const context = await collectGeneratedHeadContext(env);
    fs.mkdirSync(path.dirname(contextFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(contextFile, `${JSON.stringify(context, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return;
  }
  const context = parseContext(contextFile);
  if (command === "print-title") {
    process.stdout.write(`${context.title}\n`);
    return;
  }
  if (command === "check-dco") {
    assertDcoDeclaration(context);
    return;
  }
  throw new RepairContractError("GENERATED_HEAD_COMMAND is unsupported");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
