#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getDiff } from "../advisors/git.mts";
import { ADVISOR_OPENSHELL_INFERENCE_BASE_URL } from "../advisors/provider-constants.mts";
import {
  startOwnedOpenShellInference,
  type OwnedOpenShellInference,
  createOpenShellSandbox,
  credentialFreeEnvironment,
  defaultOpenShellTools,
  deleteOpenShellSandbox,
  downloadOpenShellPath,
  execOpenShellSandboxAsync,
  type OpenShellTools,
  required,
} from "../openshell-agent/runtime.mts";
import {
  collectGitHubReviewContext,
  type GitHubReviewContext,
  serializePreparedGitHubContext,
} from "./github-context.mts";
import { writeSpecialistDiff } from "./specialist-context.mts";

const ADVISOR_CONTEXT_DIRECTORY_NAME = "pr-review-advisor-context";
const ADVISOR_RUNTIME_DIRECTORY_NAME = "pr-review-advisor-runtime";
const ADVISOR_TOOLS_DIRECTORY_NAME = "pr-review-advisor-tools";
const ADVISOR_BOUNDARY_PROOF_DIRECTORY_NAME = ".pr-review-advisor-boundary-proof";
const REPOSITORY_BOUNDARY_PROOF_DIRECTORY = `.git/${ADVISOR_BOUNDARY_PROOF_DIRECTORY_NAME}`;
const ADVISOR_BOUNDARY_PROOF_SOURCE_NAME = "source";
const ADVISOR_BOUNDARY_PROOF_TARGET_NAME = "target";
const ADVISOR_CONTEXT_FILE_NAME = "github-context.json";
const ADVISOR_SPECIALIST_CONTEXT_DIRECTORY_NAME = "specialist";
const SANDBOX_ADVISOR_DIR = "/advisor";
const SANDBOX_WORKDIR = "/pr-workdir";
const SANDBOX_GIT_DIR = `${SANDBOX_WORKDIR}/.git`;
const SANDBOX_CONTEXT_DIR = `/${ADVISOR_CONTEXT_DIRECTORY_NAME}`;
const SANDBOX_RUNTIME_DIR = `/sandbox/${ADVISOR_RUNTIME_DIRECTORY_NAME}`;
const SANDBOX_TOOLS_DIR = `/${ADVISOR_TOOLS_DIRECTORY_NAME}`;
const SANDBOX_CONTEXT_PATH = `${SANDBOX_CONTEXT_DIR}/${ADVISOR_CONTEXT_FILE_NAME}`;
const SANDBOX_SPECIALIST_CONTEXT_DIR = `${SANDBOX_WORKDIR}/.${ADVISOR_CONTEXT_DIRECTORY_NAME}`;
const ADVISOR_RUNTIME_TMPFS_BYTES = 512 * 1024 * 1024;
const SANDBOX_API_KEY = "unused";
const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 2100;
const EXPECTED_WRITE_DENIAL_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

type PrepareAdvisorSandboxOptions = {
  collectContext?: (env: NodeJS.ProcessEnv) => Promise<GitHubReviewContext | null>;
  resolveExecutable?: (name: string, env: NodeJS.ProcessEnv) => string;
};

function runnerDirectory(env: NodeJS.ProcessEnv, name: string): string {
  return path.join(required(env.RUNNER_TEMP, "RUNNER_TEMP"), name);
}

function resetDirectory(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function createBoundaryProof(directory: string, relativeProofDirectory: string): void {
  const proofDirectory = path.join(directory, relativeProofDirectory);
  resetDirectory(proofDirectory);
  // These canaries are intentionally writable by an unrelated UID. That
  // prevents ordinary host ownership from making the sandbox proof pass when
  // neither the read-only mount nor Landlock actually blocks mutation.
  for (const [name, content] of [
    [ADVISOR_BOUNDARY_PROOF_SOURCE_NAME, "source\n"],
    [ADVISOR_BOUNDARY_PROOF_TARGET_NAME, "target\n"],
  ] as const) {
    const proofFile = path.join(proofDirectory, name);
    fs.writeFileSync(proofFile, content, { flag: "wx", mode: 0o666 });
    fs.chmodSync(proofFile, 0o666);
  }
  fs.chmodSync(proofDirectory, 0o777);
}

function writeExclusive(file: string, content: string): void {
  const fd = fs.openSync(
    file,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    // lgtm[js/network-data-to-file] The prepared GitHub context is bounded,
    // serialized JSON written to a fixed runner-owned path through an exclusive
    // 0600 descriptor. The sandbox mounts it read-only and never executes it.
    // lgtm[js/http-to-file-access]
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

function resolveExecutable(name: string, env: NodeJS.ProcessEnv): string {
  return execFileSync("which", [name], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function copyExecutable(source: string, destination: string): void {
  const resolvedSource = fs.realpathSync(source);
  if (!fs.statSync(resolvedSource).isFile()) {
    throw new Error(`Advisor runtime executable is not a regular file: ${source}`);
  }
  fs.copyFileSync(resolvedSource, destination);
  fs.chmodSync(destination, 0o755);
}

function requireDirectoryBasename(directory: string, expected: string, name: string): void {
  if (path.basename(path.resolve(directory)) !== expected) {
    throw new Error(`${name} must end in ${expected}`);
  }
}

function canonicalDirectory(directory: string, expected: string, name: string): string {
  const canonical = fs.realpathSync(directory);
  requireDirectoryBasename(canonical, expected, name);
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`${name} must be a directory`);
  }
  return canonical;
}

function requireGitMetadataDirectory(directory: string, name: string): void {
  const gitDirectory = path.join(directory, ".git");
  if (!fs.existsSync(gitDirectory) || !fs.lstatSync(gitDirectory).isDirectory()) {
    throw new Error(`${name} must contain a .git directory`);
  }
}

function advisorSandboxDriverConfig(input: {
  advisorDirectory: string;
  contextDirectory: string;
  specialistContextDirectory: string;
  toolsDirectory: string;
  workdir: string;
}): Readonly<Record<string, unknown>> {
  return {
    docker: {
      mounts: [
        {
          type: "bind",
          source: input.advisorDirectory,
          target: SANDBOX_ADVISOR_DIR,
          read_only: true,
        },
        {
          type: "bind",
          source: input.workdir,
          target: SANDBOX_WORKDIR,
          read_only: true,
        },
        {
          type: "bind",
          source: input.contextDirectory,
          target: SANDBOX_CONTEXT_DIR,
          read_only: true,
        },
        {
          type: "bind",
          source: input.specialistContextDirectory,
          target: SANDBOX_SPECIALIST_CONTEXT_DIR,
          read_only: true,
        },
        {
          type: "bind",
          source: input.toolsDirectory,
          target: SANDBOX_TOOLS_DIR,
          read_only: true,
        },
        {
          type: "tmpfs",
          target: SANDBOX_RUNTIME_DIR,
          size_bytes: ADVISOR_RUNTIME_TMPFS_BYTES,
          // Docker creates tmpfs mounts as root. The sandbox user needs the
          // mount root only to create private 0700 application directories.
          mode: 0o1777,
        },
      ],
    },
  };
}

export async function prepareAdvisorSandboxInputs(
  env: NodeJS.ProcessEnv,
  options: PrepareAdvisorSandboxOptions = {},
): Promise<void> {
  const advisorDirectory = canonicalDirectory(
    required(env.ADVISOR_DIR, "ADVISOR_DIR"),
    "advisor",
    "ADVISOR_DIR",
  );
  const advisorWorkdir = canonicalDirectory(
    required(env.ADVISOR_WORKDIR, "ADVISOR_WORKDIR"),
    "pr-workdir",
    "ADVISOR_WORKDIR",
  );
  const contextDirectory = runnerDirectory(env, ADVISOR_CONTEXT_DIRECTORY_NAME);
  const toolsDirectory = runnerDirectory(env, ADVISOR_TOOLS_DIRECTORY_NAME);
  requireGitMetadataDirectory(advisorDirectory, "ADVISOR_DIR");
  requireGitMetadataDirectory(advisorWorkdir, "ADVISOR_WORKDIR");
  resetDirectory(contextDirectory);
  resetDirectory(toolsDirectory);

  const contextEnv = { ...env };
  if (options.collectContext) delete contextEnv.PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH;
  const context = await (options.collectContext ?? collectGitHubReviewContext)(contextEnv);
  writeExclusive(
    path.join(contextDirectory, ADVISOR_CONTEXT_FILE_NAME),
    serializePreparedGitHubContext(context),
  );
  fs.chmodSync(path.join(contextDirectory, ADVISOR_CONTEXT_FILE_NAME), 0o444);
  if (env.PR_REVIEW_ADVISOR_INTEREST) {
    const baseRef = required(env.BASE_REF, "BASE_REF");
    const headRef = required(env.HEAD_REF, "HEAD_REF");
    const specialistDirectory = path.join(
      contextDirectory,
      ADVISOR_SPECIALIST_CONTEXT_DIRECTORY_NAME,
    );
    const diff = getDiff(baseRef, headRef, advisorWorkdir);
    writeSpecialistDiff(specialistDirectory, diff);
    fs.chmodSync(specialistDirectory, 0o555);
    fs.chmodSync(path.join(specialistDirectory, "diff.patch"), 0o444);
  }

  const findExecutable = options.resolveExecutable ?? resolveExecutable;
  const rg = findExecutable("rg", env);
  const fdfind = findExecutable("fdfind", env);
  copyExecutable(rg, path.join(toolsDirectory, "rg"));
  copyExecutable(fdfind, path.join(toolsDirectory, "fdfind"));
  copyExecutable(fdfind, path.join(toolsDirectory, "fd"));
  for (const executable of ["rg", "fdfind", "fd"]) {
    fs.chmodSync(path.join(toolsDirectory, executable), 0o555);
  }

  createBoundaryProof(advisorDirectory, REPOSITORY_BOUNDARY_PROOF_DIRECTORY);
  createBoundaryProof(advisorWorkdir, REPOSITORY_BOUNDARY_PROOF_DIRECTORY);
  createBoundaryProof(contextDirectory, ADVISOR_BOUNDARY_PROOF_DIRECTORY_NAME);
  createBoundaryProof(toolsDirectory, ADVISOR_BOUNDARY_PROOF_DIRECTORY_NAME);
  fs.chmodSync(contextDirectory, 0o755);
  fs.chmodSync(toolsDirectory, 0o755);
}

function advisorInferenceOptions(env: NodeJS.ProcessEnv) {
  return {
    enableBindMounts: true,
    gatewayId: "pr-review-advisor",
    modelId: required(env.PR_REVIEW_ADVISOR_MODEL, "PR_REVIEW_ADVISOR_MODEL"),
    providerName: "advisor",
  } as const;
}

export function startAdvisorOpenShellInference(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): OwnedOpenShellInference {
  return startOwnedOpenShellInference(env, advisorInferenceOptions(env), tools);
}

export function createAdvisorSandbox(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  const advisorDirectory = canonicalDirectory(
    required(env.ADVISOR_DIR, "ADVISOR_DIR"),
    "advisor",
    "ADVISOR_DIR",
  );
  const advisorWorkdir = canonicalDirectory(
    required(env.ADVISOR_WORKDIR, "ADVISOR_WORKDIR"),
    "pr-workdir",
    "ADVISOR_WORKDIR",
  );
  const contextDirectory = canonicalDirectory(
    runnerDirectory(env, ADVISOR_CONTEXT_DIRECTORY_NAME),
    ADVISOR_CONTEXT_DIRECTORY_NAME,
    "advisor context directory",
  );
  const toolsDirectory = canonicalDirectory(
    runnerDirectory(env, ADVISOR_TOOLS_DIRECTORY_NAME),
    ADVISOR_TOOLS_DIRECTORY_NAME,
    "advisor tools directory",
  );
  const sandboxName = required(env.SANDBOX_NAME, "SANDBOX_NAME");
  createOpenShellSandbox(
    env,
    {
      name: sandboxName,
      image: required(env.PI_IMAGE, "PI_IMAGE"),
      policyPath: path.join(
        advisorDirectory,
        "tools",
        "pr-review-advisor",
        "openshell-policy.yaml",
      ),
      driverConfig: advisorSandboxDriverConfig({
        advisorDirectory,
        contextDirectory,
        specialistContextDirectory: path.join(
          contextDirectory,
          ADVISOR_SPECIALIST_CONTEXT_DIRECTORY_NAME,
        ),
        toolsDirectory,
        workdir: advisorWorkdir,
      }),
      uploads: [],
      command: [
        "/usr/bin/node",
        "--experimental-strip-types",
        "--no-warnings",
        `${SANDBOX_ADVISOR_DIR}/tools/pr-review-advisor/openshell.mts`,
        "initialize",
      ],
    },
    tools,
  );
}

function passthroughEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    "BASE_REF",
    "GITHUB_REPOSITORY",
    "HEAD_REF",
    "PR_NUMBER",
    "PR_REVIEW_ADVISOR_ARTIFACT_DIR",
    "PR_REVIEW_ADVISOR_COMMENT_LABEL",
    "PR_REVIEW_ADVISOR_COMMENT_MARKER",
    "PR_REVIEW_ADVISOR_COMMENT_TITLE",
    "PR_REVIEW_ADVISOR_HEARTBEAT_MS",
    "PR_REVIEW_ADVISOR_INTEREST",
    "PR_REVIEW_ADVISOR_MAX_CAPTURE_BYTES",
    "PR_REVIEW_ADVISOR_MODEL",
    "PR_REVIEW_ADVISOR_TIMEOUT_MS",
    "PR_REVIEW_ADVISOR_UNAVAILABLE_REASON",
    "PR_REVIEW_ADVISOR_WORKFLOW_NAME",
    "PR_REVIEW_ADVISOR_WORKFLOW_PATH",
    "TARGET_REPO",
  ] as const) {
    if (env[name]) result[name] = env[name] as string;
  }
  return result;
}

function sandboxTimeoutSeconds(env: NodeJS.ProcessEnv): number {
  const value = Number.parseInt(env.PR_REVIEW_ADVISOR_SANDBOX_TIMEOUT_SECONDS ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_SANDBOX_TIMEOUT_SECONDS;
}

function advisorArtifactDirectory(env: NodeJS.ProcessEnv): string {
  const value = required(env.PR_REVIEW_ADVISOR_ARTIFACT_DIR, "PR_REVIEW_ADVISOR_ARTIFACT_DIR");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new Error("PR_REVIEW_ADVISOR_ARTIFACT_DIR must be a simple directory name");
  }
  return value;
}

export function runAdvisorSandboxAsync(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): ReturnType<typeof execOpenShellSandboxAsync> {
  advisorArtifactDirectory(env);
  return execOpenShellSandboxAsync(
    env,
    {
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      timeoutSeconds: sandboxTimeoutSeconds(env),
      workdir: SANDBOX_WORKDIR,
      environment: {
        ...passthroughEnvironment(env),
        ADVISOR_DIR: SANDBOX_ADVISOR_DIR,
        ADVISOR_WORKDIR: SANDBOX_WORKDIR,
        GIT_DIR: SANDBOX_GIT_DIR,
        GIT_WORK_TREE: SANDBOX_WORKDIR,
        GITHUB_WORKSPACE: SANDBOX_RUNTIME_DIR,
        HOME: SANDBOX_RUNTIME_DIR,
        PATH: `${SANDBOX_TOOLS_DIR}:/usr/bin`,
        PI_OFFLINE: "1",
        PR_REVIEW_ADVISOR_API_KEY: SANDBOX_API_KEY,
        PR_REVIEW_ADVISOR_BASE_URL: ADVISOR_OPENSHELL_INFERENCE_BASE_URL,
        PR_REVIEW_ADVISOR_CONFIG_DIR: `${SANDBOX_RUNTIME_DIR}/config`,
        PR_REVIEW_ADVISOR_CONTEXT_DIR: SANDBOX_SPECIALIST_CONTEXT_DIR,
        PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH: SANDBOX_CONTEXT_PATH,
        TMPDIR: `${SANDBOX_RUNTIME_DIR}/tmp`,
      },
      command: [
        "/usr/bin/node",
        "--experimental-strip-types",
        "--no-warnings",
        `${SANDBOX_ADVISOR_DIR}/tools/pr-review-advisor/run-specialist.mts`,
        "--base",
        required(env.BASE_REF, "BASE_REF"),
        "--head",
        required(env.HEAD_REF, "HEAD_REF"),
      ],
    },
    tools,
  );
}

export function downloadAdvisorArtifacts(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  const artifactDirectory = advisorArtifactDirectory(env);
  const destination = path.join(
    required(env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE"),
    "artifacts",
    artifactDirectory,
  );
  fs.mkdirSync(destination, { recursive: true });
  downloadOpenShellPath(
    env,
    {
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      source: `${SANDBOX_RUNTIME_DIR}/artifacts/${artifactDirectory}`,
      destination,
    },
    tools,
  );
}

export function deleteAdvisorSandbox(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  deleteOpenShellSandbox(env, required(env.SANDBOX_NAME, "SANDBOX_NAME"), tools);
}

export function checkAdvisorSandboxRuntime(): void {
  for (const [command, expectedPrefix] of [
    ["git", "git version "],
    ["rg", "ripgrep "],
    ["fdfind", "fdfind "],
  ] as const) {
    const output = execFileSync(command, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${SANDBOX_TOOLS_DIR}:/usr/bin` },
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (!output.startsWith(expectedPrefix)) {
      throw new Error(`Unexpected ${command} identity in advisor sandbox`);
    }
  }
  for (const directory of [
    SANDBOX_ADVISOR_DIR,
    SANDBOX_WORKDIR,
    SANDBOX_CONTEXT_DIR,
    SANDBOX_RUNTIME_DIR,
    SANDBOX_TOOLS_DIR,
  ]) {
    if (!fs.statSync(directory).isDirectory()) {
      throw new Error(`Advisor sandbox input is not a directory: ${directory}`);
    }
  }
  verifyAdvisorGitWorktree();

  const probeName = `.pr-review-advisor-write-check-${randomUUID()}`;
  for (const directory of [
    SANDBOX_RUNTIME_DIR,
    `${SANDBOX_RUNTIME_DIR}/artifacts`,
    `${SANDBOX_RUNTIME_DIR}/config`,
    `${SANDBOX_RUNTIME_DIR}/tmp`,
  ]) {
    const runtimeProbe = path.join(directory, probeName);
    const runtimeTarget = `${runtimeProbe}-target`;
    fs.writeFileSync(runtimeProbe, "runtime create check\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.writeFileSync(runtimeTarget, "runtime target check\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.writeFileSync(runtimeProbe, "runtime overwrite check\n", { flag: "w" });
    fs.chmodSync(runtimeProbe, 0o640);
    fs.renameSync(runtimeProbe, runtimeTarget);
    if (fs.readFileSync(runtimeTarget, "utf8") !== "runtime overwrite check\n") {
      throw new Error(`Advisor sandbox runtime replacement failed: ${directory}`);
    }
    fs.rmSync(runtimeTarget);
  }
  for (const [directory, relativeProofDirectory] of [
    [SANDBOX_ADVISOR_DIR, REPOSITORY_BOUNDARY_PROOF_DIRECTORY],
    [SANDBOX_WORKDIR, REPOSITORY_BOUNDARY_PROOF_DIRECTORY],
    [SANDBOX_CONTEXT_DIR, ADVISOR_BOUNDARY_PROOF_DIRECTORY_NAME],
    [SANDBOX_TOOLS_DIR, ADVISOR_BOUNDARY_PROOF_DIRECTORY_NAME],
  ] as const) {
    const proofDirectory = path.join(directory, relativeProofDirectory);
    const source = path.join(proofDirectory, ADVISOR_BOUNDARY_PROOF_SOURCE_NAME);
    const target = path.join(proofDirectory, ADVISOR_BOUNDARY_PROOF_TARGET_NAME);
    if (
      fs.readFileSync(source, "utf8") !== "source\n" ||
      fs.readFileSync(target, "utf8") !== "target\n"
    ) {
      throw new Error(`Advisor sandbox input canary is unreadable or invalid: ${directory}`);
    }
    expectWriteDenied(`${directory} chmod`, () => fs.chmodSync(source, 0o600));
    expectWriteDenied(`${directory} overwrite`, () =>
      fs.writeFileSync(target, "unexpected replacement\n", { flag: "w" }),
    );
    expectWriteDenied(`${directory} replacement`, () => fs.renameSync(source, target));
    expectWriteDenied(`${directory} create`, () =>
      fs.writeFileSync(path.join(proofDirectory, probeName), "unexpected create\n", {
        flag: "wx",
        mode: 0o600,
      }),
    );
  }
  console.log(
    "Advisor sandbox filesystem proof passed: four immutable inputs and one writable runtime",
  );
}

export function verifyAdvisorGitWorktree(
  workdir = SANDBOX_WORKDIR,
  gitDirectory = path.join(workdir, ".git"),
): void {
  const gitEnvironment = {
    ...process.env,
    GIT_DIR: gitDirectory,
    GIT_WORK_TREE: workdir,
    PATH: `${SANDBOX_TOOLS_DIR}:/usr/bin`,
  };
  let topLevel: string;
  let head: string;
  try {
    topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: gitEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    head = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8",
      env: gitEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`Advisor sandbox Git checkout is unreadable or invalid: ${workdir}`);
  }
  if (fs.realpathSync(topLevel) !== fs.realpathSync(workdir)) {
    throw new Error(`Advisor sandbox Git worktree resolved outside ${workdir}: ${topLevel}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    throw new Error(`Advisor sandbox Git HEAD is invalid: ${head}`);
  }
}

function expectWriteDenied(label: string, operation: () => void): void {
  try {
    operation();
  } catch (error: unknown) {
    if (EXPECTED_WRITE_DENIAL_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  throw new Error(`Advisor sandbox input mutation unexpectedly succeeded: ${label}`);
}

export function initializeAdvisorSandboxRuntime(): void {
  for (const name of ["artifacts", "config", "tmp"]) {
    fs.mkdirSync(path.join(SANDBOX_RUNTIME_DIR, name), { mode: 0o700 });
  }
  checkAdvisorSandboxRuntime();
}

export function runOpenShellAdvisorCommand(
  command: string | undefined,
  initialize: () => void = initializeAdvisorSandboxRuntime,
): void {
  const requiredCommand = required(command, "openshell command");
  if (requiredCommand !== "initialize") {
    throw new Error(`Unsupported OpenShell advisor command: ${requiredCommand}`);
  }
  initialize();
}

async function main(): Promise<void> {
  runOpenShellAdvisorCommand(process.argv[2]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
