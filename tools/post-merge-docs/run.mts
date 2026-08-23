#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  configureOpenShellInference,
  createOpenShellSandbox,
  defaultOpenShellTools,
  deleteOpenShellSandbox,
  downloadOpenShellPath,
  execOpenShellSandbox,
  required,
  type OpenShellTools,
} from "../openshell-agent/runtime.mts";
import {
  RESOLVER_MODEL_ID,
  resolverModelConfiguration,
} from "../pr-merge-conflict-fixer/resolve.mts";
import { allowedDocumentationPath, nextPatchReleaseTag, readBoundedFile } from "./contract.mts";

const PATCH_FILE = "docs.patch";
const REVIEW_REPORT_FILE = "review-report.txt";
const MAX_PATCH_BYTES = 5_242_880;
const MAX_REVIEW_REPORT_BYTES = 65_536;
const MAX_FILE_BYTES = 1_048_576;
const SHA = /^[0-9a-f]{40}$/u;
const AGENT_FLAGS =
  "--no-context-files --no-extensions --no-prompt-templates --no-session --no-skills --no-themes --offline --print".split(
    " ",
  );
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
};
type Phase = "author" | "review";

function fail(message: string): never {
  throw new Error(message);
}

function phase(env: NodeJS.ProcessEnv): Phase {
  const value = required(env.POST_MERGE_DOCS_PHASE, "POST_MERGE_DOCS_PHASE");
  return value === "author" || value === "review"
    ? value
    : fail("POST_MERGE_DOCS_PHASE must be author or review");
}

function exactSha(value: string | undefined, name: string): string {
  const sha = required(value, name);
  return SHA.test(sha) ? sha : fail(`${name} must be a full commit SHA`);
}

function targetReleaseTag(rangeStartTag: string): string {
  const match = /^v(\d+)[.](\d+)[.](\d+)$/u.exec(rangeStartTag);
  if (!match) fail("RANGE_START_TAG cannot produce a release target");
  return nextPatchReleaseTag(rangeStartTag, "RANGE_START_TAG cannot produce a release target");
}

function git(repository: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function reset(directory: string): void {
  fs.rmSync(directory, { force: true, recursive: true });
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
}

function write(file: string, content: string | Buffer): void {
  fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 });
}

function prepareRepository(env: NodeJS.ProcessEnv): string {
  const work = required(env.POST_MERGE_DOCS_WORKDIR, "POST_MERGE_DOCS_WORKDIR");
  const repository = path.join(work, "repo");
  const mainSha = exactSha(env.GITHUB_SHA, "GITHUB_SHA");
  reset(work);
  const source = required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT");
  execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", source, repository], {
    env: GIT_ENV,
    stdio: "inherit",
  });
  git(repository, ["checkout", "--detach", mainSha]);
  if (git(repository, ["rev-parse", "HEAD"]) !== mainSha)
    fail("The prepared checkout does not match GITHUB_SHA");
  return repository;
}

function validateCandidate(repository: string): void {
  const output = git(repository, ["diff", "--cached", "--name-only", "-z"]);
  const files = output ? output.split("\0").filter(Boolean) : [];
  if (files.length > 200) fail("Documentation patch changes too many files");
  let total = 0;
  for (const file of files) {
    if (!allowedDocumentationPath(file))
      fail(`Documentation patch contains an unsupported path: ${file}`);
    const entry = git(repository, ["ls-files", "--stage", "--", file]);
    if (!entry) continue;
    if (!entry.startsWith("100644 ")) fail(`Documentation output must be a regular file: ${file}`);
    const stat = fs.lstatSync(path.join(repository, file));
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      fail(`Documentation file is invalid or too large: ${file}`);
    total += stat.size;
  }
  if (total > MAX_PATCH_BYTES) fail("Documentation output exceeds the total size limit");
}

function patchPath(env: NodeJS.ProcessEnv): string {
  return path.join(
    required(env.POST_MERGE_DOCS_CANDIDATE_DIR, "POST_MERGE_DOCS_CANDIDATE_DIR"),
    PATCH_FILE,
  );
}

function applyPatch(repository: string, file: string): void {
  const patch = readBoundedFile(file, MAX_PATCH_BYTES, true);
  if (patch.length) {
    execFileSync(
      "git",
      ["-C", repository, "apply", "--binary", "--index", "--whitespace=nowarn", "-"],
      { env: GIT_ENV, input: patch, stdio: ["pipe", "inherit", "inherit"] },
    );
  }
  validateCandidate(repository);
}

function prompt(env: NodeJS.ProcessEnv, current: Phase): string {
  const range = exactSha(env.RANGE_START_SHA, "RANGE_START_SHA");
  const main = exactSha(env.GITHUB_SHA, "GITHUB_SHA");
  const rules =
    "Read AGENTS.md, WRITING.md, docs/AGENTS.md, docs/CONTRIBUTING.md, .agents/skills/nemoclaw-contributor-update-docs/SKILL.md, and .agents/skills/_shared/documentation-writing-review.md.";
  if (current === "review") {
    return [
      `Independently review documentation coverage for ${range}..${main}.`,
      rules,
      "Inspect the committed range and staged candidate. Do not edit the repository.",
      "Approve only if it completely and accurately covers user-visible changes, follows DORI and writing rules, and makes no unsupported claim.",
      "An empty patch is valid only when no documentation update is needed.",
      `If you reject the candidate, write a concise evidence-backed report to /sandbox/output/${REVIEW_REPORT_FILE}.`,
      'Write exactly {"outcome":"approved"} or {"outcome":"rejected"} to /sandbox/output/decision.json.',
    ].join("\n");
  }
  const tag = required(env.RANGE_START_TAG, "RANGE_START_TAG");
  return [
    `Update NemoClaw documentation for committed changes from ${tag} (${range}) through ${main}.`,
    rules,
    `Inspect git history and git diff ${range}..${main}, then verify behavior in source and tests.`,
    "Update only public docs/ files, fern/docs.yml, or files under fern/assets/.",
    "Do not change fern/fern.config.json, docs/_build, dependencies, or code.",
    "Make no speculative or unrelated edits. Do not commit. If coverage is current, leave the worktree unchanged.",
  ].join("\n");
}

function prepare(env: NodeJS.ProcessEnv): void {
  const current = phase(env);
  const repository = prepareRepository(env);
  if (current === "review") applyPatch(repository, patchPath(env));
  const output = path.join(
    required(env.POST_MERGE_DOCS_WORKDIR, "POST_MERGE_DOCS_WORKDIR"),
    "output",
  );
  const config = required(env.POST_MERGE_DOCS_CONFIG_DIR, "POST_MERGE_DOCS_CONFIG_DIR");
  fs.mkdirSync(output, { mode: 0o700 });
  reset(config);
  const models = path.join(config, "models.json");
  const task = path.join(config, "task.txt");
  write(models, resolverModelConfiguration());
  write(task, `${prompt(env, current)}\n`);
  if (current === "review") {
    fs.chmodSync(config, 0o755);
    fs.chmodSync(models, 0o444);
    fs.chmodSync(task, 0o444);
  }
}

function agentCommand(current: Phase): string[] {
  return [
    "/usr/bin/node",
    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "--provider",
    "openshell",
    "--model",
    RESOLVER_MODEL_ID,
    "--thinking",
    "medium",
    "--tools",
    current === "author" ? "read,bash,edit,write,grep,find,ls" : "read,bash,grep,find,ls",
    ...AGENT_FLAGS,
    "@/sandbox/config/task.txt",
  ];
}

function create(env: NodeJS.ProcessEnv, tools: OpenShellTools): void {
  const current = phase(env);
  const work = required(env.POST_MERGE_DOCS_WORKDIR, "POST_MERGE_DOCS_WORKDIR");
  const config = required(env.POST_MERGE_DOCS_CONFIG_DIR, "POST_MERGE_DOCS_CONFIG_DIR");
  const review = current === "review";
  const policy =
    current === "author"
      ? "pr-merge-conflict-fixer/policy.yaml"
      : "post-merge-docs/review-policy.yaml";
  createOpenShellSandbox(
    env,
    {
      command: review
        ? [
            "/usr/bin/git",
            "--git-dir=/sandbox/repo/.git",
            "--work-tree=/sandbox/repo",
            "status",
            "--short",
          ]
        : ["/usr/bin/git", "-C", "/sandbox/repo", "status", "--short"],
      image: required(env.PI_IMAGE, "PI_IMAGE"),
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      policyPath: path.join(required(env.TRUSTED_CHECKOUT, "TRUSTED_CHECKOUT"), "tools", policy),
      driverConfig: review
        ? {
            docker: {
              mounts: [
                {
                  read_only: true,
                  source: path.join(work, "repo"),
                  target: "/sandbox/repo",
                  type: "bind",
                },
                {
                  read_only: true,
                  source: config,
                  target: "/sandbox/config",
                  type: "bind",
                },
              ],
            },
          }
        : undefined,
      uploads: review
        ? []
        : [
            { destination: "/sandbox", source: path.join(work, "repo") },
            { destination: "/sandbox", source: config },
            { destination: "/sandbox", source: path.join(work, "output") },
          ],
    },
    tools,
  );
}

function run(env: NodeJS.ProcessEnv, tools: OpenShellTools): void {
  const current = phase(env);
  execOpenShellSandbox(
    env,
    {
      command: agentCommand(current),
      environment: {
        ...(current === "review"
          ? { GIT_DIR: "/sandbox/repo/.git", GIT_WORK_TREE: "/sandbox/repo" }
          : {}),
        HOME: "/sandbox/output",
        PI_CODING_AGENT_DIR: "/sandbox/config",
        PI_OFFLINE: "1",
        TMPDIR: "/sandbox/output",
      },
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      timeoutSeconds: 1200,
      workdir: "/sandbox/repo",
    },
    tools,
  );
}

function download(env: NodeJS.ProcessEnv, name: string, tools: OpenShellTools): Buffer {
  const directory = path.join(
    required(env.POST_MERGE_DOCS_WORKDIR, "POST_MERGE_DOCS_WORKDIR"),
    "download",
  );
  reset(directory);
  downloadOpenShellPath(
    env,
    {
      destination: `${directory}/`,
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      source: `/sandbox/output/${name}`,
    },
    tools,
  );
  let maximum = 1_024;
  if (name === PATCH_FILE) maximum = MAX_PATCH_BYTES;
  if (name === REVIEW_REPORT_FILE) maximum = MAX_REVIEW_REPORT_BYTES;
  return readBoundedFile(path.join(directory, name), maximum, true);
}

function exportArtifact(env: NodeJS.ProcessEnv, tools: OpenShellTools): void {
  const artifact = required(env.POST_MERGE_DOCS_ARTIFACT_DIR, "POST_MERGE_DOCS_ARTIFACT_DIR");
  reset(artifact);
  if (phase(env) === "author") {
    execOpenShellSandbox(
      env,
      {
        command: [
          "/usr/bin/bash",
          "-c",
          `set -euo pipefail\ngit add -N -- docs fern\ngit diff --binary --full-index HEAD -- docs fern > /sandbox/output/${PATCH_FILE}`,
        ],
        name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
        timeoutSeconds: 60,
        workdir: "/sandbox/repo",
      },
      tools,
    );
    const patch = download(env, PATCH_FILE, tools);
    const file = path.join(artifact, PATCH_FILE);
    write(file, patch);
    applyPatch(
      path.join(required(env.POST_MERGE_DOCS_WORKDIR, "POST_MERGE_DOCS_WORKDIR"), "repo"),
      file,
    );
    return;
  }
  const decision = download(env, "decision.json", tools).toString("utf8").trim();
  if (decision !== '{"outcome":"approved"}') {
    if (decision === '{"outcome":"rejected"}') {
      write(path.join(artifact, REVIEW_REPORT_FILE), download(env, REVIEW_REPORT_FILE, tools));
    }
    fail("Independent documentation review did not approve the candidate");
  }
  const patch = readBoundedFile(patchPath(env), MAX_PATCH_BYTES, true);
  write(path.join(artifact, PATCH_FILE), patch);
  write(
    path.join(artifact, "review.json"),
    `${JSON.stringify({
      mainSha: exactSha(env.GITHUB_SHA, "GITHUB_SHA"),
      outcome: "approved",
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      rangeStartTag: required(env.RANGE_START_TAG, "RANGE_START_TAG"),
      repository: required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
      targetReleaseTag: targetReleaseTag(required(env.RANGE_START_TAG, "RANGE_START_TAG")),
      version: 2,
    })}\n`,
  );
}

export function executePostMergeDocs(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  prepare(env);
  try {
    create(env, tools);
    run(env, tools);
    exportArtifact(env, tools);
  } finally {
    deleteOpenShellSandbox(env, required(env.SANDBOX_NAME, "SANDBOX_NAME"), tools);
  }
}

export function configurePostMergeDocs(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): Promise<void> {
  return configureOpenShellInference(
    env,
    {
      enableBindMounts: true,
      gatewayId: "post-merge-docs",
      modelId: RESOLVER_MODEL_ID,
      providerName: "docs",
    },
    tools,
  );
}

async function main(): Promise<void> {
  switch (required(process.argv[2], "command")) {
    case "configure":
      await configurePostMergeDocs(process.env);
      return;
    case "execute":
      executePostMergeDocs(process.env);
      return;
    default:
      fail(`Unsupported command: ${process.argv[2] ?? ""}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
