#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  configureOpenShellInference as configureSharedOpenShellInference,
  createOpenShellSandbox,
  defaultOpenShellTools,
  deleteOpenShellSandbox,
  downloadOpenShellPath,
  execOpenShellSandbox,
  type OpenShellTools,
  required,
} from "../openshell-agent/runtime.mts";
import { isAllowedDocumentationPath, PATCH_FILE, validateCandidateArtifact } from "./artifact.mts";
import { HARDENED_GIT_ENV, hardenedGitArgs, prepareCombinedBase } from "./base.mts";

export const DOCS_MODEL_ID = "azure/openai/gpt-5.6-terra";
export type DocsPhase = "analyze" | "review";

function phase(env: NodeJS.ProcessEnv): DocsPhase {
  const value = required(env.POST_MERGE_DOCS_PHASE, "POST_MERGE_DOCS_PHASE");
  if (value !== "analyze" && value !== "review") {
    throw new Error("POST_MERGE_DOCS_PHASE must be analyze or review");
  }
  return value;
}

export function modelConfiguration(): string {
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
              id: DOCS_MODEL_ID,
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

export function analysisPrompt(repository: string, rangeStartSha: string, mainSha: string): string {
  return [
    `Review merged changes in ${repository} from ${rangeStartSha} through exact main commit ${mainSha}.`,
    "Read AGENTS.md, WRITING.md, docs/AGENTS.md, docs/CONTRIBUTING.md, and docs/.docs-skip.",
    "Read .agents/skills/nemoclaw-contributor-update-docs/SKILL.md.",
    "Read .agents/skills/_shared/documentation-writing-review.md.",
    "Determine whether the merged changes require public documentation catch-up.",
    "If updates are required, edit only files under docs/ or fern/.",
    "Do not execute repository scripts, install dependencies, create a commit, or access the network.",
    "Return only one JSON object on stdout.",
    'Return exactly the keys "outcome", "summary", and "includesCodeSampleChanges".',
    'Set outcome to "changes" when you changed documentation.',
    'Set outcome to "no_changes" when no additional author patch is required.',
    "An open rolling PR can still contain earlier documentation changes when outcome is no_changes.",
    "Classify includesCodeSampleChanges over the complete main-to-final candidate, including existing rolling PR content and new edits.",
    "Set includesCodeSampleChanges to true when that complete candidate changes a command, code block, configuration example, or inline code sample.",
  ].join("\n");
}

export function reviewPrompt(repository: string, rangeStartSha: string, mainSha: string): string {
  return [
    `Independently review the documentation result for ${repository} from ${rangeStartSha} through exact main commit ${mainSha}.`,
    "Read the structured result in /sandbox/input/post-merge-docs-result.json.",
    "For both outcomes, review the complete candidate diff and verify its path list and code-sample classification.",
    "For a changes result, also verify the author patch is necessary and correct.",
    "For a no_changes result, independently inspect the complete merged-change range and reconstructed rolling candidate.",
    "Verify that no additional author patch beyond that candidate is required; when the candidate has no diff from main, verify that no public documentation update is required.",
    "Read AGENTS.md, WRITING.md, docs/AGENTS.md, docs/CONTRIBUTING.md, and docs/.docs-skip.",
    "Read .agents/skills/nemoclaw-contributor-update-docs/SKILL.md.",
    "Read .agents/skills/_shared/documentation-writing-review.md.",
    "Trusted documentation validation runs independently, and publication requires both validation and this review to succeed.",
    "Do not modify the repository or candidate files. Do not execute repository scripts, install dependencies, or access the network.",
    "Complete every review category before deciding.",
    "Return only one JSON object on stdout.",
    'Use {"outcome":"approved","summary":"..."} only when the result is complete and correct.',
    'Otherwise use {"outcome":"rejected","summary":"..."}.',
  ].join("\n");
}

export function prepareModelWorkspace(env: NodeJS.ProcessEnv): void {
  const selectedPhase = phase(env);
  const source = required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT");
  const workDirectory = required(env.POST_MERGE_DOCS_WORKDIR, "POST_MERGE_DOCS_WORKDIR");
  const configDirectory = required(env.POST_MERGE_DOCS_CONFIG_DIR, "POST_MERGE_DOCS_CONFIG_DIR");
  const repositoryName = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const mainSha = required(env.GITHUB_SHA, "GITHUB_SHA");
  const rangeStartSha = required(env.RANGE_START_SHA, "RANGE_START_SHA");
  const rollingHeadSha = env.ROLLING_HEAD_SHA || null;
  fs.rmSync(workDirectory, { force: true, recursive: true });
  fs.mkdirSync(workDirectory, { recursive: true });
  const combined = prepareCombinedBase({
    sourceRepository: source,
    destination: path.join(workDirectory, "repo"),
    mainSha,
    rollingHeadSha,
  });
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `base_tree_sha=${combined.baseTreeSha}\n`);
  }
  fs.rmSync(configDirectory, { force: true, recursive: true });
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDirectory, "models.json"), modelConfiguration(), {
    mode: 0o600,
  });
  fs.copyFileSync(
    new URL("./artifact.mts", import.meta.url),
    path.join(configDirectory, "artifact.mts"),
  );
  fs.copyFileSync(
    new URL("./finalize.mts", import.meta.url),
    path.join(configDirectory, "finalize.mts"),
  );
  const prompt =
    selectedPhase === "analyze"
      ? analysisPrompt(repositoryName, rangeStartSha, mainSha)
      : reviewPrompt(repositoryName, rangeStartSha, mainSha);
  fs.writeFileSync(path.join(configDirectory, "task.txt"), `${prompt}\n`, { mode: 0o600 });
  if (selectedPhase === "review") {
    const candidateSource = required(
      env.POST_MERGE_DOCS_CANDIDATE_DIR,
      "POST_MERGE_DOCS_CANDIDATE_DIR",
    );
    const candidate = validateCandidateArtifact({
      artifactDirectory: candidateSource,
      expectedRepository: repositoryName,
      expectedRangeStartSha: rangeStartSha,
      expectedMainSha: mainSha,
      expectedRollingHeadSha: rollingHeadSha,
      expectedRollingPrNumber: env.ROLLING_PR_NUMBER
        ? Number.parseInt(env.ROLLING_PR_NUMBER, 10)
        : null,
      expectedRangeStartTag: required(env.RANGE_START_TAG, "RANGE_START_TAG"),
    });
    if (candidate.result.baseTreeSha !== combined.baseTreeSha) {
      throw new Error("candidate base tree does not match the reconstructed rolling/main tree");
    }
    const inputDirectory = path.join(workDirectory, "input");
    fs.mkdirSync(inputDirectory, { mode: 0o700 });
    fs.copyFileSync(
      candidateSource + "/post-merge-docs-result.json",
      path.join(inputDirectory, "post-merge-docs-result.json"),
    );
    if (candidate.patchPath) {
      fs.copyFileSync(candidate.patchPath, path.join(inputDirectory, PATCH_FILE));
      execFileSync("git", hardenedGitArgs(["apply", "--index", "--binary", candidate.patchPath]), {
        cwd: path.join(workDirectory, "repo"),
        env: HARDENED_GIT_ENV,
        stdio: ["ignore", "ignore", "pipe"],
      });
    }
    const preparedRepository = path.join(workDirectory, "repo");
    const finalTree = execFileSync("git", hardenedGitArgs(["write-tree"]), {
      cwd: preparedRepository,
      encoding: "utf8",
      env: HARDENED_GIT_ENV,
    }).trim();
    if (finalTree !== candidate.result.finalTreeSha) {
      throw new Error("prepared review tree does not match the reviewed candidate tree");
    }
    const fullPaths = execFileSync(
      "git",
      hardenedGitArgs(["diff", "--name-only", "--no-renames", "-z", mainSha, finalTree]),
      { cwd: preparedRepository, env: HARDENED_GIT_ENV },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    if (
      fullPaths.some((file) => !isAllowedDocumentationPath(file)) ||
      fullPaths.length !== candidate.result.documentationPaths.length ||
      fullPaths.some((file, index) => file !== candidate.result.documentationPaths[index])
    ) {
      throw new Error("prepared review tree has an unapproved main-to-candidate path set");
    }
    let totalBytes = 0;
    for (const file of fullPaths) {
      const entry = execFileSync("git", hardenedGitArgs(["ls-tree", finalTree, "--", file]), {
        cwd: preparedRepository,
        encoding: "utf8",
        env: HARDENED_GIT_ENV,
      }).trim();
      if (entry && !entry.startsWith("100644 blob ")) {
        throw new Error(`prepared review tree contains a non-regular documentation file: ${file}`);
      }
      if (entry) {
        const blob = entry.split(/\s+/u)[2] ?? "";
        const size = Number.parseInt(
          execFileSync("git", hardenedGitArgs(["cat-file", "-s", blob]), {
            cwd: preparedRepository,
            encoding: "utf8",
            env: HARDENED_GIT_ENV,
          }).trim(),
          10,
        );
        if (!Number.isSafeInteger(size) || size > 1_048_576) {
          throw new Error(`prepared documentation file exceeds 1048576 bytes: ${file}`);
        }
        totalBytes += size;
      }
    }
    if (totalBytes > 5_242_880)
      throw new Error("prepared documentation files exceed 5242880 bytes");
  }
}

export async function configureInference(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): Promise<void> {
  await configureSharedOpenShellInference(
    env,
    { gatewayId: `post-merge-docs-${phase(env)}`, modelId: DOCS_MODEL_ID, providerName: "terra" },
    tools,
  );
}

export function createSandbox(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  createOpenShellSandbox(
    env,
    {
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      image: required(env.PI_IMAGE, "PI_IMAGE"),
      policyPath: path.join(
        required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
        `tools/post-merge-docs/${phase(env)}-policy.yaml`,
      ),
      uploads: [
        {
          source: path.join(
            required(env.POST_MERGE_DOCS_WORKDIR, "POST_MERGE_DOCS_WORKDIR"),
            "repo",
          ),
          destination: "/sandbox",
        },
        {
          source: required(env.POST_MERGE_DOCS_CONFIG_DIR, "POST_MERGE_DOCS_CONFIG_DIR"),
          destination: "/sandbox",
        },
        ...(phase(env) === "review"
          ? [
              {
                source: path.join(
                  required(env.POST_MERGE_DOCS_WORKDIR, "POST_MERGE_DOCS_WORKDIR"),
                  "input",
                ),
                destination: "/sandbox",
              },
            ]
          : []),
      ],
      command: ["/usr/bin/git", "-C", "/sandbox/repo", "status", "--short"],
    },
    tools,
  );
}

function piCommand(selectedPhase: DocsPhase): readonly string[] {
  const tools =
    selectedPhase === "analyze" ? "read,bash,edit,write,grep,find,ls" : "read,bash,grep,find,ls";
  const output = selectedPhase === "analyze" ? "model-result.json" : "model-review.json";
  const command = [
    "/usr/bin/node",
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "--provider",
    "openshell",
    "--model",
    DOCS_MODEL_ID,
    "--thinking",
    "medium",
    "--tools",
    tools,
    "--no-context-files",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-session",
    "--no-skills",
    "--no-themes",
    "--offline",
    "--print",
    "@/sandbox/config/task.txt",
  ];
  return [
    "/usr/bin/bash",
    "-c",
    `set -euo pipefail; mkdir -p /sandbox/runtime/model-output; "$@" > /sandbox/runtime/model-output/${output}`,
    "pi",
    ...command,
  ];
}

export function runModel(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  execOpenShellSandbox(
    env,
    {
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      timeoutSeconds: 1200,
      workdir: "/sandbox/repo",
      environment: {
        HOME: "/sandbox/runtime",
        PI_CODING_AGENT_DIR: "/sandbox/config",
        PI_OFFLINE: "1",
        TMPDIR: "/sandbox/runtime",
      },
      command: piCommand(phase(env)),
    },
    tools,
  );
}

export function exportArtifacts(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  const sandboxName = required(env.SANDBOX_NAME, "SANDBOX_NAME");
  const selectedPhase = phase(env);
  const exportCommand =
    selectedPhase === "analyze"
      ? `set -euo pipefail
mkdir -p /sandbox/runtime/export
git -c core.hooksPath=/dev/null add -N -A
git diff --binary --full-index --no-ext-diff --no-textconv "$POST_MERGE_DOCS_BASE_TREE_SHA" > /sandbox/runtime/export/post-merge-docs.patch
cp /sandbox/runtime/model-output/model-result.json /sandbox/runtime/export/model-result.json`
      : `set -euo pipefail
mkdir -p /sandbox/runtime/export
cp /sandbox/runtime/model-output/model-review.json /sandbox/runtime/export/model-review.json`;
  execOpenShellSandbox(
    env,
    {
      name: sandboxName,
      workdir: "/sandbox/repo",
      environment: {
        POST_MERGE_DOCS_BASE_TREE_SHA: required(
          env.POST_MERGE_DOCS_BASE_TREE_SHA,
          "POST_MERGE_DOCS_BASE_TREE_SHA",
        ),
      },
      command: ["/usr/bin/bash", "-c", exportCommand],
    },
    tools,
  );
  const destination = required(env.POST_MERGE_DOCS_ARTIFACT_DIR, "POST_MERGE_DOCS_ARTIFACT_DIR");
  const rawDirectory = path.join(
    required(env.RUNNER_TEMP, "RUNNER_TEMP"),
    `post-merge-docs-${selectedPhase}-export`,
  );
  fs.rmSync(rawDirectory, { force: true, recursive: true });
  fs.mkdirSync(rawDirectory, { recursive: true, mode: 0o700 });
  downloadOpenShellPath(
    env,
    { name: sandboxName, source: "/sandbox/runtime/export", destination: rawDirectory },
    tools,
  );
  deleteOpenShellSandbox(env, sandboxName, tools);
  fs.rmSync(destination, { force: true, recursive: true });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  execFileSync(
    "/usr/bin/node",
    [
      "--experimental-strip-types",
      path.join(
        required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"),
        "tools/post-merge-docs/finalize.mts",
      ),
    ],
    {
      env: {
        ...env,
        POST_MERGE_DOCS_PHASE: selectedPhase,
        POST_MERGE_DOCS_RAW_EXPORT_DIR: rawDirectory,
        POST_MERGE_DOCS_OUTPUT_DIR: destination,
      },
      stdio: "inherit",
    },
  );
}

export function deleteSandbox(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  deleteOpenShellSandbox(env, required(env.SANDBOX_NAME, "SANDBOX_NAME"), tools);
}

async function main(): Promise<void> {
  switch (required(process.argv[2], "model command")) {
    case "prepare":
      prepareModelWorkspace(process.env);
      return;
    case "configure":
      await configureInference(process.env);
      return;
    case "create":
      createSandbox(process.env);
      return;
    case "run":
      runModel(process.env);
      return;
    case "export":
      exportArtifacts(process.env);
      return;
    case "delete":
      deleteSandbox(process.env);
      return;
    default:
      throw new Error("Unsupported post-merge docs model command");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
