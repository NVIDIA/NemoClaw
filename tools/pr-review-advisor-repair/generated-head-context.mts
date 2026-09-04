#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hasControlCharacters } from "../advisors/canonical-json.mts";
import { githubApi } from "../advisors/github.mts";
import {
  CANONICAL_REPOSITORY,
  PHASE1_PILOT_AUTHOR,
  parseFullSha as fullSha,
  parsePositiveInteger as positiveInteger,
  RepairContractError,
  readBoundedJson,
  requiredEnvironment as required,
  sanitizeDiagnostic,
} from "./contract.mts";
import { TRUSTED_GENERATED_HEAD_REF } from "./generated-head-validation.mts";

type GitHubRequest = <T>(apiPath: string, token: string) => Promise<T>;

export type GeneratedHeadPullRequest = {
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
  author: typeof PHASE1_PILOT_AUTHOR;
};

function boundedText(
  value: unknown,
  name: string,
  maximum: number,
  allowLineBreaks = false,
): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximum ||
    hasControlCharacters(value, allowLineBreaks ? [10, 13] : [])
  ) {
    throw new RepairContractError(`${name} must be bounded text`);
  }
  return value;
}

export function assertGeneratedHeadPullRequestIdentity(
  pull: GeneratedHeadPullRequest,
  expected: { prNumber: number; sourceHeadSha: string; baseSha: string },
): void {
  if (
    pull.number !== expected.prNumber ||
    pull.state !== "open" ||
    pull.draft !== false ||
    pull.maintainer_can_modify !== true ||
    pull.user?.login !== PHASE1_PILOT_AUTHOR ||
    pull.head?.sha !== expected.sourceHeadSha ||
    pull.head?.repo?.full_name !== CANONICAL_REPOSITORY ||
    pull.base?.sha !== expected.baseSha ||
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== CANONICAL_REPOSITORY
  ) {
    throw new RepairContractError("live pull request no longer matches generated-head dispatch");
  }
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

  const pull = await request<GeneratedHeadPullRequest>(
    `repos/${CANONICAL_REPOSITORY}/pulls/${prNumber}`,
    required(env, "GITHUB_TOKEN"),
  );
  assertGeneratedHeadPullRequestIdentity(pull, { prNumber, sourceHeadSha, baseSha });
  return {
    version: 1,
    repository: CANONICAL_REPOSITORY,
    prNumber,
    sourceHeadSha,
    baseSha,
    repairAttemptKey,
    title: boundedText(pull.title, "pull request title", 512),
    body: boundedText(pull.body ?? "", "pull request body", 128 * 1024, true),
    author: PHASE1_PILOT_AUTHOR,
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
    value.author !== PHASE1_PILOT_AUTHOR
  ) {
    throw new RepairContractError("generated-head context is malformed");
  }
  return value as GeneratedHeadContext;
}

export function assertDcoDeclaration(context: GeneratedHeadContext): void {
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
    // lgtm[js/network-data-to-file] The verified PR context is length-bounded,
    // serialized as data, and written exclusively to a fixed runner-owned 0600
    // path. Downstream consumers parse it strictly and never execute it.
    // lgtm[js/http-to-file-access]
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
