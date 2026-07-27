#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ADVISOR_OPENSHELL_INFERENCE_BASE_URL } from "../advisors/provider-constants.mts";
import {
  configureOpenShellInference,
  createOpenShellSandbox,
  credentialFreeEnvironment,
  defaultOpenShellTools,
  deleteOpenShellSandbox,
  downloadOpenShellPath,
  execOpenShellSandbox,
  type OpenShellTools,
  required,
} from "../openshell-agent/runtime.mts";
import {
  collectGitHubReviewContext,
  type GitHubReviewContext,
  serializePreparedGitHubContext,
} from "./github-context.mts";

const ADVISOR_CONTEXT_DIRECTORY_NAME = "pr-review-advisor-context";
const ADVISOR_RUNTIME_DIRECTORY_NAME = "pr-review-advisor-runtime";
const ADVISOR_TOOLS_DIRECTORY_NAME = "pr-review-advisor-tools";
const ADVISOR_CONTEXT_FILE_NAME = "github-context.json";
const SANDBOX_ADVISOR_DIR = "/sandbox/advisor";
const SANDBOX_WORKDIR = "/sandbox/pr-workdir";
const SANDBOX_CONTEXT_DIR = `/sandbox/${ADVISOR_CONTEXT_DIRECTORY_NAME}`;
const SANDBOX_RUNTIME_DIR = `/sandbox/${ADVISOR_RUNTIME_DIRECTORY_NAME}`;
const SANDBOX_TOOLS_DIR = `/sandbox/${ADVISOR_TOOLS_DIRECTORY_NAME}`;
const SANDBOX_CONTEXT_PATH = `${SANDBOX_CONTEXT_DIR}/${ADVISOR_CONTEXT_FILE_NAME}`;
const SANDBOX_API_KEY = "unused";
const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 2100;
const DEFAULT_UNAVAILABLE_REASON =
  "OpenShell inference configuration failed or the advisor credential is unavailable";

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

export async function prepareAdvisorSandboxInputs(
  env: NodeJS.ProcessEnv,
  options: PrepareAdvisorSandboxOptions = {},
): Promise<void> {
  const contextDirectory = runnerDirectory(env, ADVISOR_CONTEXT_DIRECTORY_NAME);
  const runtimeDirectory = runnerDirectory(env, ADVISOR_RUNTIME_DIRECTORY_NAME);
  const toolsDirectory = runnerDirectory(env, ADVISOR_TOOLS_DIRECTORY_NAME);
  resetDirectory(contextDirectory);
  resetDirectory(runtimeDirectory);
  resetDirectory(toolsDirectory);
  for (const name of ["artifacts", "config", "tmp"]) {
    fs.mkdirSync(path.join(runtimeDirectory, name), { mode: 0o700 });
  }

  const contextEnv = { ...env };
  delete contextEnv.PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH;
  const context = await (options.collectContext ?? collectGitHubReviewContext)(contextEnv);
  writeExclusive(
    path.join(contextDirectory, ADVISOR_CONTEXT_FILE_NAME),
    serializePreparedGitHubContext(context),
  );

  const findExecutable = options.resolveExecutable ?? resolveExecutable;
  const rg = findExecutable("rg", env);
  const fdfind = findExecutable("fdfind", env);
  copyExecutable(rg, path.join(toolsDirectory, "rg"));
  copyExecutable(fdfind, path.join(toolsDirectory, "fdfind"));
  copyExecutable(fdfind, path.join(toolsDirectory, "fd"));
}

export async function configureAdvisorOpenShellInference(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): Promise<void> {
  await configureOpenShellInference(
    env,
    {
      gatewayId: "pr-review-advisor",
      modelId: required(env.PR_REVIEW_ADVISOR_MODEL, "PR_REVIEW_ADVISOR_MODEL"),
      providerName: "advisor",
    },
    tools,
  );
}

export function writeUnavailableAdvisorArtifacts(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  const advisorDirectory = required(env.ADVISOR_DIR, "ADVISOR_DIR");
  const commandEnv = credentialFreeEnvironment({
    ...env,
    PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH: path.join(
      runnerDirectory(env, ADVISOR_CONTEXT_DIRECTORY_NAME),
      ADVISOR_CONTEXT_FILE_NAME,
    ),
    PR_REVIEW_ADVISOR_RUN_ANALYSIS: "0",
    PR_REVIEW_ADVISOR_UNAVAILABLE_REASON:
      env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON || DEFAULT_UNAVAILABLE_REASON,
  });
  tools.run(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      path.join(advisorDirectory, "tools", "pr-review-advisor", "run-analysis.mts"),
    ],
    { env: commandEnv },
  );
}

export function createAdvisorSandbox(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  const advisorDirectory = required(env.ADVISOR_DIR, "ADVISOR_DIR");
  const advisorWorkdir = required(env.ADVISOR_WORKDIR, "ADVISOR_WORKDIR");
  const sandboxName = required(env.SANDBOX_NAME, "SANDBOX_NAME");
  requireDirectoryBasename(advisorDirectory, "advisor", "ADVISOR_DIR");
  requireDirectoryBasename(advisorWorkdir, "pr-workdir", "ADVISOR_WORKDIR");

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
      uploads: [
        { source: advisorDirectory, destination: "/sandbox" },
        { source: advisorWorkdir, destination: "/sandbox" },
        {
          source: runnerDirectory(env, ADVISOR_CONTEXT_DIRECTORY_NAME),
          destination: "/sandbox",
        },
        {
          source: runnerDirectory(env, ADVISOR_RUNTIME_DIRECTORY_NAME),
          destination: "/sandbox",
        },
        {
          source: runnerDirectory(env, ADVISOR_TOOLS_DIRECTORY_NAME),
          destination: "/sandbox",
        },
      ],
      command: [
        "/usr/bin/node",
        "--experimental-strip-types",
        "--no-warnings",
        `${SANDBOX_ADVISOR_DIR}/tools/pr-review-advisor/openshell.mts`,
        "seal",
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
    "PR_REVIEW_ADVISOR_LOAD_PREVIOUS_REVIEW",
    "PR_REVIEW_ADVISOR_MAX_CAPTURE_BYTES",
    "PR_REVIEW_ADVISOR_MODEL",
    "PR_REVIEW_ADVISOR_RUN_ANALYSIS",
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

export function runAdvisorSandbox(
  env: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): void {
  advisorArtifactDirectory(env);
  execOpenShellSandbox(
    env,
    {
      name: required(env.SANDBOX_NAME, "SANDBOX_NAME"),
      timeoutSeconds: sandboxTimeoutSeconds(env),
      workdir: SANDBOX_WORKDIR,
      environment: {
        ...passthroughEnvironment(env),
        ADVISOR_DIR: SANDBOX_ADVISOR_DIR,
        ADVISOR_WORKDIR: SANDBOX_WORKDIR,
        GITHUB_WORKSPACE: SANDBOX_RUNTIME_DIR,
        HOME: SANDBOX_RUNTIME_DIR,
        PATH: `${SANDBOX_TOOLS_DIR}:/usr/bin`,
        PI_OFFLINE: "1",
        PR_REVIEW_ADVISOR_API_KEY: SANDBOX_API_KEY,
        PR_REVIEW_ADVISOR_BASE_URL: ADVISOR_OPENSHELL_INFERENCE_BASE_URL,
        PR_REVIEW_ADVISOR_CONFIG_DIR: `${SANDBOX_RUNTIME_DIR}/config`,
        PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH: SANDBOX_CONTEXT_PATH,
        TMPDIR: `${SANDBOX_RUNTIME_DIR}/tmp`,
      },
      command: [
        "/usr/bin/node",
        "--experimental-strip-types",
        "--no-warnings",
        `${SANDBOX_ADVISOR_DIR}/tools/pr-review-advisor/run-analysis.mts`,
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

  const probeName = `.pr-review-advisor-write-check-${randomUUID()}`;
  for (const directory of [
    SANDBOX_RUNTIME_DIR,
    `${SANDBOX_RUNTIME_DIR}/artifacts`,
    `${SANDBOX_RUNTIME_DIR}/config`,
    `${SANDBOX_RUNTIME_DIR}/tmp`,
  ]) {
    const runtimeProbe = path.join(directory, probeName);
    fs.writeFileSync(runtimeProbe, "runtime write check\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.rmSync(runtimeProbe);
  }
  for (const directory of [
    SANDBOX_ADVISOR_DIR,
    SANDBOX_WORKDIR,
    SANDBOX_CONTEXT_DIR,
    SANDBOX_TOOLS_DIR,
  ]) {
    const readOnlyProbe = path.join(directory, probeName);
    try {
      fs.writeFileSync(readOnlyProbe, "unexpected write\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error: unknown) {
      if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        continue;
      }
      throw error;
    }
    fs.rmSync(readOnlyProbe, { force: true });
    throw new Error(`Advisor sandbox input is unexpectedly writable: ${directory}`);
  }
}

export function sealAdvisorSandboxInputs(
  directories: readonly string[] = [
    SANDBOX_ADVISOR_DIR,
    SANDBOX_WORKDIR,
    SANDBOX_CONTEXT_DIR,
    SANDBOX_TOOLS_DIR,
  ],
  verify: () => void = checkAdvisorSandboxRuntime,
): void {
  // OpenShell v0.0.85 performs uploads after applying the sandbox policy, so
  // /sandbox must remain policy-writable. Remove ordinary write modes before
  // model code starts as an accidental-mutation guard; the Advisor's
  // repo-confined read-only tools remain the model-facing write boundary.
  execFileSync("/bin/chmod", ["-R", "a-w", ...directories], { stdio: "inherit" });
  verify();
}

async function main(): Promise<void> {
  const command = required(process.argv[2], "openshell command");
  switch (command) {
    case "prepare":
      await prepareAdvisorSandboxInputs(process.env);
      return;
    case "configure":
      await configureAdvisorOpenShellInference(process.env);
      return;
    case "unavailable":
      writeUnavailableAdvisorArtifacts(process.env);
      return;
    case "create":
      createAdvisorSandbox(process.env);
      return;
    case "run":
      runAdvisorSandbox(process.env);
      return;
    case "download":
      downloadAdvisorArtifacts(process.env);
      return;
    case "delete":
      deleteAdvisorSandbox(process.env);
      return;
    case "check":
      checkAdvisorSandboxRuntime();
      return;
    case "seal":
      sealAdvisorSandboxInputs();
      return;
    default:
      throw new Error(`Unsupported OpenShell advisor command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
