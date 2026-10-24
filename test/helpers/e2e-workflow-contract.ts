// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type WorkflowJob = {
  concurrency?: { group: string; queue?: "max"; "cancel-in-progress": boolean };
  environment?: string | { name: string; deployment?: boolean };
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  uses?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  with?: Record<string, string>;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: Record<string, unknown>;
  };
};

export type WorkflowStep = {
  "continue-on-error"?: boolean;
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};

export type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

export type CompositeAction = {
  inputs?: Record<string, { default?: unknown }>;
  runs: {
    steps: WorkflowStep[];
  };
};

export function readRepoText(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

export function readYaml<T>(path: string): T {
  return YAML.parse(readRepoText(path)) as T;
}

export function topLevelAndTerms(expression: string | undefined): string[] {
  if (!expression?.startsWith("${{") || !expression.endsWith("}}")) return [];

  const body = expression.slice(3, -2).trim();
  const terms: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let termStart = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && character === "|" && body[index + 1] === "|") return [];
    if (depth === 0 && character === "&" && body[index + 1] === "&") {
      terms.push(body.slice(termStart, index).trim());
      termStart = index + 2;
      index += 1;
    }
  }
  terms.push(body.slice(termStart).trim());
  return depth === 0 && quote === undefined ? terms : [];
}

export function readWorkflow(): Record<string, unknown> {
  return readYaml(".github/workflows/e2e.yaml");
}

export function removeJobNeed(source: string, ownerJob: string, dependency: string): string {
  const ownerHeader = `  ${ownerJob}:\n`;
  const ownerStart = source.indexOf(ownerHeader);
  if (ownerStart < 0) {
    throw new Error(`workflow is missing job ${ownerJob}`);
  }
  const prefix = source.slice(0, ownerStart);
  const afterOwnerHeader = ownerStart + ownerHeader.length;
  const nextJobOffset = source.slice(afterOwnerHeader).search(/^  [\w-]+:\n/mu);
  const ownerEnd = nextJobOffset < 0 ? source.length : afterOwnerHeader + nextJobOffset;
  const ownerBlock = source.slice(ownerStart, ownerEnd);
  const needle = `        ${dependency},\n`;
  if (!ownerBlock.includes(needle)) {
    throw new Error(`${ownerJob} does not need ${dependency}`);
  }
  return prefix + ownerBlock.replace(needle, "") + source.slice(ownerEnd);
}
