#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  configureOpenShellInference as configureSharedOpenShellInference,
  createOpenShellSandbox,
  defaultOpenShellTools,
  deleteOpenShellSandbox,
  downloadOpenShellPath,
  execOpenShellSandbox,
  type OpenShellCommandOptions,
  type OpenShellStartOptions,
  type OpenShellTools,
  required,
} from "../openshell-agent/runtime.mts";
import { type ConflictMatrixEntry, parseConflictMatrixEntry } from "./discover.mts";
import { ConflictFixerError, prepareMerge, samePaths } from "./merge.mts";

export const RESOLVER_MODEL_ID = "azure/openai/gpt-5.6-terra";

const PI_COMMAND = [
  "/usr/bin/node",
  "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  "--provider",
  "openshell",
  "--model",
  RESOLVER_MODEL_ID,
  "--thinking",
  "medium",
  "--tools",
  "read,bash,edit,write,grep,find,ls",
  "--no-context-files",
  "--no-extensions",
  "--no-prompt-templates",
  "--no-session",
  "--no-skills",
  "--no-themes",
  "--offline",
  "--print",
  "@/sandbox/pi-config/task.txt",
] as const;
const EXPORT_PATCH_COMMAND = `
set -euo pipefail
if test -n "$(git ls-files -u)"; then
  echo "Pi did not stage every resolved conflict." >&2
  exit 1
fi
final_tree="$(git write-tree)"
git diff --binary "$CONFLICT_TREE" "$final_tree" > /sandbox/resolution.patch
`.trim();

export type ResolverCommandOptions = OpenShellCommandOptions;
export type ResolverStartOptions = OpenShellStartOptions;
export type ResolverTools = OpenShellTools;

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
              id: RESOLVER_MODEL_ID,
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

export async function configureOpenShellInference(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultOpenShellTools,
): Promise<void> {
  await configureSharedOpenShellInference(
    env,
    {
      gatewayId: "pr-conflict-fixer",
      modelId: RESOLVER_MODEL_ID,
      providerName: "terra",
    },
    tools,
  );
}

export function createResolutionSandbox(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultOpenShellTools,
): void {
  createOpenShellSandbox(
    env,
    {
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      image: required(env.PI_IMAGE, "PI_IMAGE"),
      policyPath: path.join(
        required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
        "tools",
        "pr-merge-conflict-fixer",
        "policy.yaml",
      ),
      uploads: [
        {
          source: required(env.RESOLUTION_WORKDIR, "RESOLUTION_WORKDIR"),
          destination: "/sandbox",
        },
        {
          source: required(env.RESOLVER_CONFIG_DIR, "RESOLVER_CONFIG_DIR"),
          destination: "/sandbox",
        },
      ],
      command: ["/usr/bin/git", "-C", "/sandbox/repo", "status", "--short"],
    },
    tools,
  );
}

export function runResolutionTask(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultOpenShellTools,
): void {
  execOpenShellSandbox(
    env,
    {
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      timeoutSeconds: 1200,
      workdir: "/sandbox/repo",
      environment: {
        HOME: "/sandbox",
        PI_CODING_AGENT_DIR: "/sandbox/pi-config",
        PI_OFFLINE: "1",
        TMPDIR: "/sandbox",
      },
      command: PI_COMMAND,
    },
    tools,
  );
}

export function exportResolutionPatch(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultOpenShellTools,
): void {
  const sandboxName = required(env.SANDBOX_NAME, "SANDBOX_NAME");
  execOpenShellSandbox(
    env,
    {
      name: sandboxName,
      workdir: "/sandbox/repo",
      environment: {
        CONFLICT_TREE: required(env.CONFLICT_TREE, "CONFLICT_TREE"),
      },
      command: ["/usr/bin/bash", "-c", EXPORT_PATCH_COMMAND],
    },
    tools,
  );
  const artifactDirectory = required(env.ARTIFACT_DIR, "ARTIFACT_DIR");
  mkdirSync(artifactDirectory, { recursive: true });
  downloadOpenShellPath(
    env,
    {
      name: sandboxName,
      source: "/sandbox/resolution.patch",
      destination: `${artifactDirectory}/`,
    },
    tools,
  );
}

export function deleteResolutionSandbox(
  env: NodeJS.ProcessEnv,
  tools: ResolverTools = defaultOpenShellTools,
): void {
  deleteOpenShellSandbox(env, required(env.SANDBOX_NAME, "SANDBOX_NAME"), tools);
}

function prepare(env: NodeJS.ProcessEnv): void {
  const entry = parseConflictMatrixEntry(required(env.MATRIX_ENTRY, "MATRIX_ENTRY"));
  const conflictTree = prepareResolutionWorkspace({
    configDirectory: required(env.RESOLVER_CONFIG_DIR, "RESOLVER_CONFIG_DIR"),
    entry,
    sourceRepository: required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
    workDirectory: required(env.RESOLUTION_WORKDIR, "RESOLUTION_WORKDIR"),
  });
  appendFileSync(required(env.GITHUB_OUTPUT, "GITHUB_OUTPUT"), `conflict_tree=${conflictTree}\n`);
}

async function main(): Promise<void> {
  const command = required(process.argv[2], "resolve command");
  switch (command) {
    case "prepare":
      prepare(process.env);
      return;
    case "configure":
      await configureOpenShellInference(process.env);
      return;
    case "create":
      createResolutionSandbox(process.env);
      return;
    case "run":
      runResolutionTask(process.env);
      return;
    case "export":
      exportResolutionPatch(process.env);
      return;
    case "delete":
      deleteResolutionSandbox(process.env);
      return;
    default:
      throw new ConflictFixerError(`Unsupported resolve command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
