#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { githubRest } from "../advisors/github.mts";
import {
  gitIsolationEnvironment,
  HERMETIC_GIT_ARGS,
  safeEnvironmentValue,
} from "../advisors/hermetic-git.mts";
import {
  createOpenShellSandbox,
  defaultOpenShellTools,
  deleteOpenShellSandbox,
  execOpenShellSandbox,
  type OpenShellTools,
  startOwnedOpenShellGateway,
} from "../openshell-agent/runtime.mts";
import {
  collectPullRequestReviewState,
  type PullRequestReviewState,
  pullRequestReviewStateDigest,
} from "../pr-review-advisor/review-state.mts";
import {
  assertRepairContractSchema,
  CANONICAL_REPOSITORY,
  type ChangedPath,
  MAX_CHANGED_FILE_BYTES,
  MAX_CHANGED_FILES,
  MAX_PATCH_BYTES,
  parseProposalReceipt,
  parseSelectionBundle,
  RepairContractError,
  readBoundedJson,
  readBoundedRegularFile,
  requiredEnvironment as required,
  repairClassForPath,
  type SelectionBundle,
  sanitizeDiagnostic,
  sha256,
  type ValidationCommand,
  type ValidationReceipt,
} from "./contract.mts";

type GitHubRequest = <T>(apiPath: string, token: string) => Promise<T>;

const EMPTY_SHA = "0".repeat(40);
const EMPTY_DIGEST = `sha256:${sha256("")}`;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const SANDBOX_REPOSITORY = "/sandbox/repo";
const VALIDATION_TIMEOUT_SECONDS = 30 * 60;
const DEPENDENCY_CONTROL_PATHS = [
  ".npmrc",
  "package.json",
  "package-lock.json",
  "nemoclaw/.npmrc",
  "nemoclaw/package.json",
  "nemoclaw/package-lock.json",
] as const;
const SECRET_PATTERNS = [
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bghp_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bnvapi-[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/'"]+@/iu,
] as const;

class ValidationCommandError extends RepairContractError {
  readonly command: ValidationCommand;

  constructor(message: string, command: ValidationCommand) {
    super(message);
    this.name = "ValidationCommandError";
    this.command = command;
  }
}

class ValidationSequenceError extends RepairContractError {
  readonly commands: ValidationCommand[];

  constructor(message: string, commands: ValidationCommand[]) {
    super(message);
    this.name = "ValidationSequenceError";
    this.commands = commands;
  }
}

type ValidationRunner = (
  repository: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ValidationCommand;

export function validationEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "LANG",
    "LC_ALL",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TZ",
  ]) {
    const value = env[name];
    if (value && safeEnvironmentValue(value)) result[name] = value;
  }
  const temporaryDirectory = path.join(home, "tmp");
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  return {
    ...result,
    CI: "1",
    GITHUB_ACTIONS: "true",
    ...gitIsolationEnvironment(home),
    NPM_CONFIG_CACHE: path.join(home, "npm-cache"),
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    TMPDIR: temporaryDirectory,
  };
}

function validationControlEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    "HOME",
    "LANG",
    "LC_ALL",
    "OPENSHELL_GATEWAY_ENDPOINT",
    "PATH",
    "RUNNER_TEMP",
    "TRUSTED_CHECKOUT",
    "TZ",
    "VALIDATION_IMAGE",
    "VALIDATION_SANDBOX_NAME",
    "XDG_BIN_HOME",
  ]) {
    const value = env[name];
    if (value && safeEnvironmentValue(value)) result[name] = value;
  }
  for (const name of [
    "HOME",
    "OPENSHELL_GATEWAY_ENDPOINT",
    "PATH",
    "RUNNER_TEMP",
    "TRUSTED_CHECKOUT",
    "VALIDATION_IMAGE",
    "VALIDATION_SANDBOX_NAME",
  ]) {
    if (!result[name]) throw new RepairContractError(`${name} is required`);
  }
  return result;
}

function sandboxValidationEnvironment(): Readonly<Record<string, string>> {
  return {
    CI: "1",
    GITHUB_ACTIONS: "true",
    ...(gitIsolationEnvironment("/sandbox/home") as Record<string, string>),
    NPM_CONFIG_CACHE: "/sandbox/npm-cache",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: "/sandbox/tmp",
  };
}

function runGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  encoding: "utf8" | "buffer" = "utf8",
): string | Buffer {
  return execFileSync("git", [...HERMETIC_GIT_ARGS, ...args], {
    cwd,
    env,
    encoding: encoding === "utf8" ? "utf8" : undefined,
    maxBuffer: MAX_PATCH_BYTES + 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertExactCleanSource(
  sourceCheckout: string,
  sourceHeadSha: string,
  env: NodeJS.ProcessEnv,
): void {
  const head = String(runGit(sourceCheckout, ["rev-parse", "HEAD"], env)).trim();
  if (head !== sourceHeadSha)
    throw new RepairContractError("validation source is not at the selected head");
  if (String(runGit(sourceCheckout, ["status", "--porcelain=v1", "--untracked-files=all"], env))) {
    throw new RepairContractError("validation source checkout is not clean");
  }
}

const GENERATED_HEAD_DENIED_PREFIXES = [
  ".agents/",
  ".claude/",
  ".github/",
  "ci/",
  "scripts/",
  "test/e2e/",
  "tools/",
] as const;

const GENERATED_HEAD_DENIED_BASENAMES = new Set([
  ".gitattributes",
  ".gitmodules",
  ".npmrc",
  "AGENTS.md",
  "biome.json",
  "CODEOWNERS",
  "SECURITY.md",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "yarn.lock",
]);

export function assertEligibleSourceDiff(
  repository: string,
  selection: SelectionBundle,
  env: NodeJS.ProcessEnv,
): void {
  runGit(repository, ["cat-file", "-e", `${selection.input.baseSha}^{commit}`], env);
  const output = String(
    runGit(
      repository,
      [
        "diff",
        "--name-only",
        "-z",
        `${selection.input.baseSha}...${selection.input.sourceHeadSha}`,
        "--",
      ],
      env,
    ),
  );
  const paths = output.split("\0").filter(Boolean);
  const denied = paths.find((changedPath) => {
    const basename = path.posix.basename(changedPath);
    return (
      GENERATED_HEAD_DENIED_BASENAMES.has(basename) ||
      /^tsconfig(?:[.].+)?[.]json$/u.test(basename) ||
      GENERATED_HEAD_DENIED_PREFIXES.some((prefix) => changedPath.startsWith(prefix))
    );
  });
  if (denied) {
    throw new RepairContractError(
      `pull request changes a control surface that Phase 1 cannot validate: ${denied}`,
    );
  }
}

function parseNameStatus(output: Buffer): Array<{ status: "A" | "D" | "M"; path: string }> {
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) throw new RepairContractError("Git returned malformed path status");
  const result: Array<{ status: "A" | "D" | "M"; path: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const changedPath = fields[index + 1];
    if (!["A", "D", "M"].includes(status ?? "") || !changedPath) {
      throw new RepairContractError("repair patch contains an unsupported change status");
    }
    result.push({ status: status as "A" | "D" | "M", path: changedPath });
  }
  return result;
}

function parseGitObject(
  line: string,
  expectedPath: string,
  source: "index" | "tree",
): { mode: string; type: string } {
  const match =
    source === "tree"
      ? /^(\d{6}) (\w+) [0-9a-f]{40,64}\t([^\0]+)\0?$/u.exec(line)
      : /^(\d{6}) [0-9a-f]{40,64} 0\t([^\0]+)\0?$/u.exec(line);
  const actualPath = source === "tree" ? match?.[3] : match?.[2];
  if (!match || actualPath !== expectedPath) {
    throw new RepairContractError(`Git object identity is malformed for ${expectedPath}`);
  }
  return {
    mode: match[1] ?? "",
    type: source === "tree" ? (match[2] ?? "") : "blob",
  };
}

function inspectChangedPaths(
  repository: string,
  selection: SelectionBundle,
  env: NodeJS.ProcessEnv,
): ChangedPath[] {
  const status = parseNameStatus(
    runGit(
      repository,
      ["diff", "--cached", "--name-status", "-z", "--no-renames", "HEAD", "--"],
      env,
      "buffer",
    ) as Buffer,
  );
  if (status.length === 0 || status.length > MAX_CHANGED_FILES) {
    throw new RepairContractError("validated proposal must change between one and twenty files");
  }
  const paths = status.map(({ path: changedPath }) => changedPath);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((item) => !selection.selectedPaths.includes(item))
  ) {
    throw new RepairContractError("repair patch escapes the selected exact-path allowlist");
  }

  return status.map(({ path: changedPath, status: changeStatus }): ChangedPath => {
    const repairClass = repairClassForPath(changedPath);
    if (!repairClass)
      throw new RepairContractError(`repair patch uses unsupported path ${changedPath}`);
    const objectLine = String(
      changeStatus === "D"
        ? runGit(repository, ["ls-tree", "-z", "HEAD", "--", changedPath], env)
        : runGit(repository, ["ls-files", "--stage", "-z", "--", changedPath], env),
    );
    const object = parseGitObject(objectLine, changedPath, changeStatus === "D" ? "tree" : "index");
    if (object.mode !== "100644" || object.type !== "blob") {
      throw new RepairContractError(`repair patch uses an unsafe Git object for ${changedPath}`);
    }
    const objectName = changeStatus === "D" ? `HEAD:${changedPath}` : `:${changedPath}`;
    const bytes = Number.parseInt(
      String(runGit(repository, ["cat-file", "-s", objectName], env)),
      10,
    );
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_CHANGED_FILE_BYTES) {
      throw new RepairContractError(`repair patch exceeds the per-file limit for ${changedPath}`);
    }
    const content = runGit(repository, ["show", objectName], env, "buffer") as Buffer;
    if (content.includes(0)) {
      throw new RepairContractError(`repair patch contains binary data at ${changedPath}`);
    }
    const text = content.toString("utf8");
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new RepairContractError(
        `repair patch contains a possible credential at ${changedPath}`,
      );
    }
    return {
      path: changedPath,
      status: changeStatus,
      mode: "100644",
      type: "blob",
      bytes,
    };
  });
}

function assertSafeSelectedSourceObjects(
  repository: string,
  selection: SelectionBundle,
  env: NodeJS.ProcessEnv,
): void {
  for (const selectedPath of selection.selectedPaths) {
    const segments = selectedPath.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const current = segments.slice(0, length).join("/");
      const line = String(runGit(repository, ["ls-tree", "-z", "HEAD", "--", current], env));
      if (!line) continue;
      const object = parseGitObject(line, current, "tree");
      const isLeaf = length === segments.length;
      if (isLeaf && (object.mode !== "100644" || object.type !== "blob")) {
        throw new RepairContractError(
          `selected source path is not a regular blob: ${selectedPath}`,
        );
      }
      if (!isLeaf && (object.mode !== "040000" || object.type !== "tree")) {
        throw new RepairContractError(`selected source path has an unsafe parent: ${selectedPath}`);
      }
    }
  }
}

function candidateSnapshot(
  repository: string,
  sourceHeadSha: string,
  env: NodeJS.ProcessEnv,
): string {
  const patch = runGit(
    repository,
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-renames",
      sourceHeadSha,
      "HEAD",
      "--",
    ],
    env,
    "buffer",
  ) as Buffer;
  const status = String(
    runGit(
      repository,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
      env,
    ),
  )
    .split("\0")
    .filter(
      (entry) =>
        entry.length > 0 && entry !== "!! node_modules/" && entry !== "!! nemoclaw/node_modules/",
    )
    .join("\0");
  const head = String(runGit(repository, ["rev-parse", "HEAD"], env)).trim();
  return `sha256:${sha256(Buffer.concat([Buffer.from(`${head}\0`), patch, Buffer.from(status)]))}`;
}

function materializeCandidateCommit(
  repository: string,
  selection: SelectionBundle,
  candidateTreeSha: string,
  env: NodeJS.ProcessEnv,
): void {
  runGit(repository, ["cat-file", "-e", `${selection.input.baseSha}^{commit}`], env);
  const commitEnvironment = {
    ...env,
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_AUTHOR_EMAIL: "phase1-validator@example.invalid",
    GIT_AUTHOR_NAME: "Phase 1 Validator",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_EMAIL: "phase1-validator@example.invalid",
    GIT_COMMITTER_NAME: "Phase 1 Validator",
  };
  const candidateCommit = String(
    runGit(
      repository,
      [
        "commit-tree",
        candidateTreeSha,
        "-p",
        selection.input.sourceHeadSha,
        "-m",
        "chore: materialize Phase 1 validation candidate",
      ],
      commitEnvironment,
    ),
  ).trim();
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    throw new RepairContractError("ephemeral validation commit is malformed");
  }
  runGit(repository, ["checkout", "--detach", candidateCommit], env);
  runGit(repository, ["update-ref", "refs/remotes/origin/main", selection.input.baseSha], env);
}

function isDependencyPreparation(command: string, args: readonly string[]): boolean {
  if (command !== "npm") return false;
  const expected = [
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${PUBLIC_NPM_REGISTRY}`],
    [
      "--prefix",
      "nemoclaw",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${PUBLIC_NPM_REGISTRY}`,
    ],
  ];
  return expected.some((candidate) => JSON.stringify(candidate) === JSON.stringify(args));
}

function runHostDependencyPreparation(
  repository: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ValidationCommand {
  if (!isDependencyPreparation(command, args)) {
    throw new RepairContractError("host validation may only prepare trusted dependencies");
  }
  try {
    execFileSync(command, args, {
      cwd: repository,
      env,
      stdio: "inherit",
      timeout: 30 * 60 * 1000,
    });
    return { argv: [command, ...args], exitCode: 0 };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    const exitCode = Number.isInteger(status) && (status as number) >= 0 ? (status as number) : 1;
    const result = { argv: [command, ...args], exitCode };
    throw new ValidationCommandError(`trusted dependency preparation failed: ${command}`, result);
  }
}

function canonicalDirectory(resource: string, name: string): string {
  const canonical = fs.realpathSync(resource);
  const stat = fs.lstatSync(canonical);
  if (!stat.isDirectory()) {
    throw new RepairContractError(`${name} must be a regular directory`);
  }
  return canonical;
}

export type OpenShellValidationRunner = {
  cleanup: () => void;
  commandRunner: ValidationRunner;
};

export function createOpenShellValidationRunner(
  controlEnv: NodeJS.ProcessEnv,
  tools: OpenShellTools = defaultOpenShellTools,
): OpenShellValidationRunner {
  const safeControlEnv = validationControlEnvironment(controlEnv);
  const image = required(safeControlEnv, "VALIDATION_IMAGE");
  if (!/@sha256:[0-9a-f]{64}$/u.test(image)) {
    throw new RepairContractError("VALIDATION_IMAGE must be pinned by digest");
  }
  const sandboxName = required(safeControlEnv, "VALIDATION_SANDBOX_NAME");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sandboxName)) {
    throw new RepairContractError("VALIDATION_SANDBOX_NAME contains unsupported characters");
  }
  const policyPath = path.join(
    canonicalDirectory(required(safeControlEnv, "TRUSTED_CHECKOUT"), "TRUSTED_CHECKOUT"),
    "tools",
    "pr-review-advisor-repair",
    "validation-policy.yaml",
  );
  if (!fs.lstatSync(policyPath).isFile() || fs.lstatSync(policyPath).isSymbolicLink()) {
    throw new RepairContractError("validation policy must be a regular trusted file");
  }
  let repositoryIdentity: string | undefined;
  let sandboxAttempted = false;

  const ensureSandbox = (repository: string): void => {
    const canonicalRepository = canonicalDirectory(repository, "validation repository");
    repositoryIdentity ??= canonicalRepository;
    if (repositoryIdentity !== canonicalRepository) {
      throw new RepairContractError("validation runner cannot change repository identity");
    }
    if (sandboxAttempted) return;
    const mounts: Array<Record<string, unknown>> = [
      {
        type: "bind",
        source: canonicalRepository,
        target: SANDBOX_REPOSITORY,
        read_only: false,
      },
      {
        type: "bind",
        source: canonicalDirectory(path.join(canonicalRepository, ".git"), "candidate Git data"),
        target: `${SANDBOX_REPOSITORY}/.git`,
        read_only: true,
      },
      {
        type: "bind",
        source: canonicalDirectory(
          path.join(canonicalRepository, "node_modules"),
          "root dependency tree",
        ),
        target: `${SANDBOX_REPOSITORY}/node_modules`,
        read_only: true,
      },
    ];
    const pluginDependencies = path.join(canonicalRepository, "nemoclaw", "node_modules");
    if (fs.existsSync(pluginDependencies)) {
      mounts.push({
        type: "bind",
        source: canonicalDirectory(pluginDependencies, "plugin dependency tree"),
        target: `${SANDBOX_REPOSITORY}/nemoclaw/node_modules`,
        read_only: true,
      });
    }
    sandboxAttempted = true;
    createOpenShellSandbox(
      safeControlEnv,
      {
        command: ["/usr/bin/test", "-d", SANDBOX_REPOSITORY],
        driverConfig: { docker: { mounts } },
        image,
        name: sandboxName,
        policyPath,
        uploads: [],
      },
      tools,
    );
  };

  return {
    cleanup() {
      if (sandboxAttempted) deleteOpenShellSandbox(safeControlEnv, sandboxName, tools);
    },
    commandRunner(repository, command, args, env) {
      if (isDependencyPreparation(command, args)) {
        return runHostDependencyPreparation(repository, command, args, env);
      }
      ensureSandbox(repository);
      try {
        execOpenShellSandbox(
          safeControlEnv,
          {
            command: [command, ...args],
            environment: sandboxValidationEnvironment(),
            name: sandboxName,
            timeoutSeconds: VALIDATION_TIMEOUT_SECONDS,
            workdir: SANDBOX_REPOSITORY,
          },
          tools,
        );
        return { argv: [command, ...args], exitCode: 0 };
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const exitCode =
          Number.isInteger(status) && (status as number) >= 0 ? (status as number) : 1;
        throw new ValidationCommandError(`sandbox validation command failed: ${command}`, {
          argv: [command, ...args],
          exitCode,
        });
      }
    },
  };
}

function assertTrustedDependencyInputs(
  repository: string,
  selection: SelectionBundle,
  env: NodeJS.ProcessEnv,
): void {
  const changed = String(
    runGit(
      repository,
      [
        "diff",
        "--name-only",
        "-z",
        selection.input.baseSha,
        selection.input.sourceHeadSha,
        "--",
        ...DEPENDENCY_CONTROL_PATHS,
      ],
      env,
    ),
  )
    .split("\0")
    .filter(Boolean);
  if (changed.length > 0) {
    throw new RepairContractError(
      `validation refuses PR-controlled dependency inputs: ${changed.join(", ")}`,
    );
  }
}

export function validationCommands(
  changedPaths: readonly ChangedPath[],
  sourceHeadSha: string,
): Array<[string, string[]]> {
  const vitest = (...projects: string[]): [string, string[]] => [
    "npx",
    [
      "--no-install",
      "vitest",
      "run",
      "--changed",
      sourceHeadSha,
      ...projects.flatMap((project) => ["--project", project]),
    ],
  ];
  const classes = new Set(
    changedPaths.map(({ path: changedPath }) => repairClassForPath(changedPath)),
  );
  const changesInstallerContract = changedPaths.some(({ path: changedPath }) =>
    changedPath.startsWith("test/installer-integration/"),
  );
  const changesPackageContract = changedPaths.some(({ path: changedPath }) =>
    changedPath.startsWith("test/package-contract/"),
  );
  const commands: Array<[string, string[]]> = [
    [
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", `--registry=${PUBLIC_NPM_REGISTRY}`],
    ],
  ];
  if (changedPaths.some(({ path: changedPath }) => changedPath.startsWith("nemoclaw/"))) {
    commands.push([
      "npm",
      [
        "--prefix",
        "nemoclaw",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--registry=${PUBLIC_NPM_REGISTRY}`,
      ],
    ]);
  }
  if (classes.size === 1 && classes.has("documentation")) {
    commands.push(["npm", ["run", "docs"]]);
  } else {
    commands.push(
      ["npm", ["run", "check:diff"]],
      [
        "npx",
        [
          "--no-install",
          "vitest",
          "run",
          "--project",
          "integration",
          "test/automation/pull-requests/growth-guardrails.test.ts",
        ],
      ],
      vitest("cli", "integration", "plugin"),
    );
    if (changesInstallerContract) {
      commands.push(vitest("installer-integration"));
    }
    if (changesPackageContract) {
      commands.push(
        ["npm", ["run", "build:cli"]],
        ["npm", ["--prefix", "nemoclaw", "run", "build"]],
        vitest("package-contract"),
      );
    }
  }
  return commands;
}

export async function assertLivePullRequestIdentity(
  selection: SelectionBundle,
  token: string,
  request: GitHubRequest = githubRest,
): Promise<void> {
  const pull = await request<{
    number?: unknown;
    state?: unknown;
    draft?: unknown;
    maintainer_can_modify?: unknown;
    user?: { login?: unknown };
    head?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } };
    base?: { sha?: unknown; ref?: unknown; repo?: { full_name?: unknown } };
  }>(`repos/${CANONICAL_REPOSITORY}/pulls/${selection.input.prNumber}`, token);
  if (
    pull.number !== selection.input.prNumber ||
    pull.state !== "open" ||
    pull.draft !== false ||
    pull.maintainer_can_modify !== true ||
    pull.user?.login !== selection.input.pullRequest.author ||
    pull.head?.sha !== selection.input.sourceHeadSha ||
    pull.head?.ref !== selection.input.pullRequest.headRef ||
    pull.head?.repo?.full_name !== CANONICAL_REPOSITORY ||
    pull.base?.sha !== selection.input.baseSha ||
    pull.base?.ref !== "main" ||
    pull.base?.repo?.full_name !== CANONICAL_REPOSITORY
  ) {
    throw new RepairContractError("live pull request identity changed after selection");
  }
}

export async function assertLiveReviewStateIdentity(
  selection: SelectionBundle,
  token: string,
  collect: (
    repository: string,
    prNumber: number,
    token: string,
  ) => Promise<PullRequestReviewState> = collectPullRequestReviewState,
): Promise<void> {
  const state = await collect(CANONICAL_REPOSITORY, selection.input.prNumber, token);
  if (
    state.headSha !== selection.input.sourceHeadSha ||
    pullRequestReviewStateDigest(state) !== selection.input.advisor.reviewStateDigest
  ) {
    throw new RepairContractError("live review-thread state changed after selection");
  }
}

function runValidationSequence(input: {
  repository: string;
  planned: Array<[string, string[]]>;
  env: NodeJS.ProcessEnv;
  runner: ValidationRunner;
  receipts: ValidationCommand[];
  failure: string;
  afterEach: () => void;
}): void {
  for (const [command, args] of input.planned) {
    try {
      const receipt = input.runner(input.repository, command, args, input.env);
      input.receipts.push(receipt);
      if (receipt.exitCode !== 0) {
        throw new ValidationSequenceError(input.failure, input.receipts);
      }
    } catch (error) {
      if (error instanceof ValidationCommandError) input.receipts.push(error.command);
      if (error instanceof ValidationSequenceError) throw error;
      throw new ValidationSequenceError(
        error instanceof Error ? error.message : input.failure,
        input.receipts,
      );
    }
    input.afterEach();
  }
}

export function validateRepairLocally(input: {
  sourceCheckout: string;
  selection: SelectionBundle;
  patchFile: string;
  proposalFile: string;
  stagingDirectory: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: ValidationRunner;
}): { patch: Buffer; receipt: ValidationReceipt } {
  const home = path.join(input.stagingDirectory, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = validationEnvironment(input.env ?? process.env, home);
  assertExactCleanSource(input.sourceCheckout, input.selection.input.sourceHeadSha, env);
  assertEligibleSourceDiff(input.sourceCheckout, input.selection, env);
  const patch = readBoundedRegularFile(input.patchFile, MAX_PATCH_BYTES, true);
  const proposal = parseProposalReceipt(
    readBoundedJson(input.proposalFile, 512 * 1024),
    input.selection,
  );
  const baseReceipt = {
    version: 1 as const,
    attemptKey: input.selection.attemptKey,
    repository: CANONICAL_REPOSITORY as typeof CANONICAL_REPOSITORY,
    prNumber: input.selection.input.prNumber,
    author: input.selection.input.pullRequest.author,
    headRef: input.selection.input.pullRequest.headRef,
    sourceHeadSha: input.selection.input.sourceHeadSha,
    baseSha: input.selection.input.baseSha,
    advisor: input.selection.input.advisor,
    findingIds: input.selection.selectedFindingIds,
    selectedPaths: input.selection.selectedPaths,
    patchSha256: sha256(patch),
    productScope: input.selection.input.productScope,
    optIn: input.selection.input.optIn,
  };
  if (proposal.outcome !== "proposed") {
    if (patch.length !== 0)
      throw new RepairContractError("non-proposal repair artifact must be empty");
    return {
      patch,
      receipt: {
        ...baseReceipt,
        candidateTreeSha: EMPTY_SHA,
        changedPaths: [],
        validation: {
          candidateDigestBefore: EMPTY_DIGEST,
          candidateDigestAfter: EMPTY_DIGEST,
          commands: [],
        },
        outcome: "skipped",
        reason: proposal.outcome === "blocked" ? proposal.summary : "Pi reported no change",
      },
    };
  }
  if (patch.length === 0) throw new RepairContractError("proposed repair artifact is empty");

  const repository = path.join(input.stagingDirectory, "repo");
  runGit(
    input.stagingDirectory,
    ["clone", "--no-local", "--no-hardlinks", "--no-checkout", input.sourceCheckout, repository],
    env,
  );
  runGit(repository, ["checkout", "--detach", input.selection.input.sourceHeadSha], env);
  assertSafeSelectedSourceObjects(repository, input.selection, env);
  runGit(
    repository,
    ["apply", "--check", "--index", "--binary", "--whitespace=error-all", input.patchFile],
    env,
  );
  runGit(
    repository,
    ["apply", "--index", "--binary", "--whitespace=error-all", input.patchFile],
    env,
  );
  runGit(repository, ["diff", "--cached", "--check", "HEAD", "--"], env);
  const changedPaths = inspectChangedPaths(repository, input.selection, env);
  const actualPaths = changedPaths.map(({ path: changedPath }) => changedPath);
  if (
    actualPaths.length !== proposal.changedPaths.length ||
    actualPaths.some((changedPath, index) => changedPath !== proposal.changedPaths[index])
  ) {
    throw new RepairContractError("applied patch does not match the proposal receipt");
  }

  const candidateTreeSha = String(runGit(repository, ["write-tree"], env)).trim();
  if (!/^[0-9a-f]{40}$/u.test(candidateTreeSha)) {
    throw new RepairContractError("candidate tree does not use the expected Git object format");
  }
  materializeCandidateCommit(repository, input.selection, candidateTreeSha, env);
  if (String(runGit(repository, ["status", "--porcelain=v1", "--untracked-files=all"], env))) {
    throw new RepairContractError("ephemeral validation candidate is not clean");
  }
  assertTrustedDependencyInputs(repository, input.selection, env);
  const commands: ValidationCommand[] = [];
  if (!input.commandRunner) {
    throw new RepairContractError("a sandbox validation command runner is required");
  }
  const runner = input.commandRunner;
  const plannedCommands = validationCommands(changedPaths, input.selection.input.sourceHeadSha);
  const dependencyCommands = plannedCommands.filter(([command, args]) =>
    isDependencyPreparation(command, args),
  );
  const repositoryCommands = plannedCommands.filter(
    ([command, args]) => !isDependencyPreparation(command, args),
  );
  runValidationSequence({
    repository,
    planned: dependencyCommands,
    env,
    runner,
    receipts: commands,
    failure: "trusted dependency preparation returned failure",
    afterEach: () => {
      const status = String(
        runGit(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], env),
      );
      if (status) {
        throw new RepairContractError("trusted dependency preparation mutated the candidate");
      }
    },
  });
  const before = candidateSnapshot(repository, input.selection.input.sourceHeadSha, env);
  runValidationSequence({
    repository,
    planned: repositoryCommands,
    env,
    runner,
    receipts: commands,
    failure: "trusted validation command returned failure",
    afterEach: () => {
      const status = String(
        runGit(repository, ["status", "--porcelain=v1", "--untracked-files=all"], env),
      );
      if (status) {
        throw new RepairContractError("trusted validation mutated the candidate working tree");
      }
      if (candidateSnapshot(repository, input.selection.input.sourceHeadSha, env) !== before) {
        throw new RepairContractError("trusted validation changed the candidate patch");
      }
    },
  });
  const after = candidateSnapshot(repository, input.selection.input.sourceHeadSha, env);
  return {
    patch,
    receipt: {
      ...baseReceipt,
      candidateTreeSha,
      changedPaths,
      validation: {
        candidateDigestBefore: before,
        candidateDigestAfter: after,
        commands,
      },
      outcome: "validated",
      reason: null,
    },
  };
}

function rejectedReceipt(
  selection: SelectionBundle,
  patchFile: string,
  reason: string,
  commands: ValidationCommand[] = [],
): ValidationReceipt {
  let patchDigest = sha256("");
  try {
    patchDigest = sha256(readBoundedRegularFile(patchFile, MAX_PATCH_BYTES, true));
  } catch {
    // The rejection reason records the unsafe or missing patch. Do not read it by another path.
  }
  return {
    version: 1,
    attemptKey: selection.attemptKey,
    repository: CANONICAL_REPOSITORY,
    prNumber: selection.input.prNumber,
    author: selection.input.pullRequest.author,
    headRef: selection.input.pullRequest.headRef,
    sourceHeadSha: selection.input.sourceHeadSha,
    baseSha: selection.input.baseSha,
    advisor: selection.input.advisor,
    findingIds: selection.selectedFindingIds,
    selectedPaths: selection.selectedPaths,
    patchSha256: patchDigest,
    candidateTreeSha: EMPTY_SHA,
    changedPaths: [],
    validation: {
      candidateDigestBefore: EMPTY_DIGEST,
      candidateDigestAfter: EMPTY_DIGEST,
      commands,
    },
    productScope: selection.input.productScope,
    optIn: selection.input.optIn,
    outcome: "rejected",
    reason: sanitizeDiagnostic(reason),
  };
}

export function writeValidationArtifacts(
  directory: string,
  receipt: ValidationReceipt,
  patch: Buffer | null,
): void {
  assertRepairContractSchema("validation-receipt", receipt);
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.existsSync(directory)) {
    throw new RepairContractError("validation artifact destination already exists");
  }
  const staged = `${directory}.staged-${randomUUID()}`;
  fs.mkdirSync(staged, { mode: 0o700 });
  try {
    if (patch && receipt.outcome === "validated") {
      fs.writeFileSync(path.join(staged, "validated.patch"), patch, {
        flag: "wx",
        mode: 0o600,
      });
    }
    // lgtm[js/network-data-to-file] The receipt contains strictly parsed,
    // bounded metadata and is written as non-executable JSON to an exclusive
    // 0600 file beneath a fresh runner-owned artifact directory.
    // lgtm[js/http-to-file-access]
    fs.writeFileSync(
      path.join(staged, "validation-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    fs.renameSync(staged, directory);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

async function runValidation(env: NodeJS.ProcessEnv): Promise<void> {
  const selectionFile = required(env, "SELECTION_FILE");
  const patchFile = required(env, "REPAIR_PATCH_FILE");
  const selection = parseSelectionBundle(readBoundedJson(selectionFile, 1024 * 1024));
  const artifactDirectory = required(env, "VALIDATION_ARTIFACT_DIR");
  let runner: OpenShellValidationRunner | undefined;
  let gateway: ReturnType<typeof startOwnedOpenShellGateway> | undefined;
  try {
    const token = required(env, "GITHUB_TOKEN");
    await assertLivePullRequestIdentity(selection, token);
    await assertLiveReviewStateIdentity(selection, token);
    const proposalFile = required(env, "PROPOSAL_FILE");
    const proposal = parseProposalReceipt(readBoundedJson(proposalFile, 512 * 1024), selection);
    if (proposal.outcome === "proposed") {
      const controlEnv = validationControlEnvironment(env);
      gateway = startOwnedOpenShellGateway(controlEnv, {
        enableBindMounts: true,
        gatewayId: "pr-review-advisor-repair-validation",
      });
      await gateway.ready;
      runner = createOpenShellValidationRunner(controlEnv);
    }
    const result = validateRepairLocally({
      sourceCheckout: required(env, "SOURCE_CHECKOUT"),
      selection,
      patchFile,
      proposalFile,
      stagingDirectory: required(env, "VALIDATION_STAGING_DIR"),
      env,
      commandRunner: runner?.commandRunner,
    });
    runner?.cleanup();
    runner = undefined;
    await gateway?.stop();
    gateway = undefined;
    await assertLivePullRequestIdentity(selection, token);
    await assertLiveReviewStateIdentity(selection, token);
    writeValidationArtifacts(artifactDirectory, result.receipt, result.patch);
    fs.appendFileSync(
      required(env, "GITHUB_OUTPUT"),
      `validated=${result.receipt.outcome === "validated"}\n`,
    );
  } catch (error) {
    let failure: unknown = error;
    if (runner) {
      try {
        runner.cleanup();
      } catch (cleanupError) {
        failure = new AggregateError(
          [failure, cleanupError],
          `${sanitizeDiagnostic(failure)}; validation sandbox cleanup also failed: ${sanitizeDiagnostic(cleanupError)}`,
          { cause: failure },
        );
      }
    }
    if (gateway) {
      try {
        await gateway.stop();
      } catch (cleanupError) {
        failure = new AggregateError(
          [failure, cleanupError],
          `${sanitizeDiagnostic(failure)}; validation gateway cleanup also failed: ${sanitizeDiagnostic(cleanupError)}`,
          { cause: failure },
        );
      }
    }
    const reason = sanitizeDiagnostic(failure);
    const receipt = rejectedReceipt(
      selection,
      patchFile,
      reason,
      error instanceof ValidationSequenceError ? error.commands : [],
    );
    if (!fs.existsSync(artifactDirectory)) {
      writeValidationArtifacts(artifactDirectory, receipt, null);
    }
    throw failure;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runValidation(process.env).catch((error: unknown) => {
    console.error(sanitizeDiagnostic(error));
    process.exit(1);
  });
}
