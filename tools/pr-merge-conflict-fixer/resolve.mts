#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { type ConflictMatrixEntry, parseConflictMatrixEntry } from "./discover.mts";
import { ConflictFixerError, prepareMerge, samePaths } from "./merge.mts";

const MODEL_ID = "azure/openai/gpt-5.6-terra";

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConflictFixerError(`${name} is required`);
  return value;
}

export function resolverModelConfiguration(): string {
  return `${JSON.stringify(
    {
      providers: {
        openshell: {
          api: "openai-completions",
          apiKey: "unused",
          baseUrl: "https://inference.local/v1",
          compat: {
            maxTokensField: "max_tokens",
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsStore: false,
            supportsStrictMode: false,
            supportsUsageInStreaming: false,
          },
          models: [
            {
              contextWindow: 256000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: MODEL_ID,
              input: ["text"],
              maxTokens: 32768,
              name: "GPT-5.6 Terra",
              reasoning: false,
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function resolverPrompt(): string {
  return [
    "Resolve the Git merge conflicts in this repository.",
    "The repository is merging main into a pull request head.",
    "Preserve the intended behavior from both parents.",
    "Do not make unrelated changes.",
    "Use Git to inspect the merge state.",
    "Stage every resolved conflict with Git.",
    "Do not create a commit.",
  ].join("\n");
}

export function prepareResolutionWorkspace(input: {
  configDirectory: string;
  entry: ConflictMatrixEntry;
  sourceRepository: string;
  workDirectory: string;
}): string {
  const merge = prepareMerge(
    input.sourceRepository,
    input.workDirectory,
    input.entry.head_sha,
    input.entry.base_sha,
  );
  if (!merge) throw new ConflictFixerError("The recorded PR no longer conflicts with the base SHA");
  if (!samePaths(merge.conflictPaths, input.entry.conflict_paths)) {
    throw new ConflictFixerError("The conflict paths do not match the scan result");
  }

  mkdirSync(input.configDirectory, { recursive: true });
  writeFileSync(path.join(input.configDirectory, "models.json"), resolverModelConfiguration(), {
    mode: 0o600,
  });
  writeFileSync(path.join(input.configDirectory, "task.txt"), `${resolverPrompt()}\n`, {
    mode: 0o600,
  });
  return merge.conflictTree;
}

function main(): void {
  const entry = parseConflictMatrixEntry(required(process.env.MATRIX_ENTRY, "MATRIX_ENTRY"));
  const conflictTree = prepareResolutionWorkspace({
    configDirectory: required(process.env.RESOLVER_CONFIG_DIR, "RESOLVER_CONFIG_DIR"),
    entry,
    sourceRepository: required(process.env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
    workDirectory: required(process.env.RESOLUTION_WORKDIR, "RESOLUTION_WORKDIR"),
  });
  appendFileSync(
    required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT"),
    `conflict_tree=${conflictTree}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
