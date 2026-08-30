#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_ADVISOR_MODEL } from "../advisors/provider-constants.mts";
import { ADVISOR_PI_IMAGE, LOCAL_OPENSHELL_GATEWAY_ENDPOINT } from "./runtime-constants.mts";
import {
  createAdvisorSandbox,
  deleteAdvisorSandbox,
  downloadAdvisorArtifacts,
  prepareAdvisorSandboxInputs,
  runAdvisorSandboxAsync,
  startAdvisorOpenShellInference,
} from "./openshell.mts";
import {
  redactAdvisorDiagnostic,
  runAdvisorSpecialist,
  type AdvisorSpecialistLifecycle,
} from "./specialist-lifecycle.mts";
import { ADVISOR_SPECIALISTS, type AdvisorSpecialist } from "./specialist-catalog.mts";

const LOCAL_OUTPUT_DIRECTORY = path.join("artifacts", "pr-review-advisor-local");

export type LocalReviewLifecycle = AdvisorSpecialistLifecycle;

export type LocalReviewPublication = {
  copy: typeof fs.cpSync;
  remove: typeof fs.rmSync;
  rename: typeof fs.renameSync;
};

const defaultLocalReviewPublication: LocalReviewPublication = {
  copy: fs.cpSync,
  remove: fs.rmSync,
  rename: fs.renameSync,
};

function safeDiagnostic(error: unknown): string {
  return redactAdvisorDiagnostic(
    error instanceof Error ? error.message : "Unknown non-Error failure",
  );
}

function safeFailure(error: unknown): Error {
  if (error instanceof AggregateError) {
    const failures = error.errors.map((failure: unknown) => safeFailure(failure));
    return new AggregateError(failures, safeDiagnostic(error), {
      cause: error.cause === undefined ? undefined : safeFailure(error.cause),
    });
  }
  if (error instanceof Error) {
    return new Error(safeDiagnostic(error), {
      cause: error.cause === undefined ? undefined : safeFailure(error.cause),
    });
  }
  return new Error(safeDiagnostic(error));
}

function contextualError(message: string, cause: unknown): Error {
  const safeCause = safeFailure(cause);
  return new Error(`${message}: ${safeCause.message}`, { cause: safeCause });
}

function combineFailures(first: unknown, next: unknown): unknown {
  if (next === undefined) return first;
  if (first === undefined) return next;
  const safeFirst = safeFailure(first);
  const safeNext = safeFailure(next);
  return new AggregateError([safeFirst, safeNext], `${safeFirst.message}; ${safeNext.message}`, {
    cause: safeFirst,
  });
}

export const defaultLocalReviewLifecycle: LocalReviewLifecycle = {
  prepare: (env) => prepareAdvisorSandboxInputs(env, { collectContext: async () => null }),
  startGateway: (env) => startAdvisorOpenShellInference(env)!,
  create: createAdvisorSandbox,
  run: runAdvisorSandboxAsync,
  download: downloadAdvisorArtifacts,
  remove: deleteAdvisorSandbox,
};

function restrictedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_EMAIL: "local-review@localhost",
    GIT_AUTHOR_NAME: "NemoClaw Local Review",
    GIT_COMMITTER_EMAIL: "local-review@localhost",
    GIT_COMMITTER_NAME: "NemoClaw Local Review",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
}

function disabledFilters(cwd: string): string[] {
  const names = new Set<string>();
  for (const entry of fs.readdirSync(cwd, { recursive: true, withFileTypes: true })) {
    if (
      entry.name !== ".gitattributes" &&
      !(entry.name === "attributes" && entry.parentPath.endsWith(path.join(".git", "info")))
    )
      continue;
    for (const match of fs
      .readFileSync(path.join(entry.parentPath, entry.name), "utf8")
      .matchAll(/(?:^|\s)filter=([^\s]+)/gmu)) {
      if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(match[1]!)) names.add(match[1]!);
    }
  }
  return [...names].flatMap((name) => [
    "-c",
    `filter.${name}.clean=`,
    "-c",
    `filter.${name}.smudge=`,
    "-c",
    `filter.${name}.process=`,
    "-c",
    `filter.${name}.required=false`,
  ]);
}

function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync(
    "git",
    [
      "-c",
      `core.hooksPath=${os.devNull}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      ...disabledFilters(cwd),
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: restrictedGitEnvironment(),
      input,
      maxBuffer: Number.POSITIVE_INFINITY,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
}

function gitValue(cwd: string, args: readonly string[]): string {
  return git(cwd, args).trim();
}

function copyUntrackedFiles(source: string, destination: string): void {
  const files = git(source, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const relativePath of files.split("\0").filter(Boolean)) {
    const sourcePath = path.join(source, relativePath);
    const destinationPath = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true, verbatimSymlinks: true });
  }
}

function removeSnapshotSymlinks(directory: string): void {
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) fs.rmSync(path.join(entry.parentPath, entry.name), { force: true });
  }
}

export function createLocalReviewSnapshot(
  source: string,
  destination: string,
  baseRef = gitValue(source, ["rev-parse", "--verify", "origin/main^{commit}"]),
): { baseRef: string; headRef: string } {
  git(path.dirname(destination), ["clone", "--no-hardlinks", "--no-checkout", source, destination]);
  const initialHead = gitValue(destination, ["rev-parse", "HEAD"]);
  git(destination, ["read-tree", initialHead]);
  const archive = execFileSync("git", ["archive", initialHead], {
    cwd: destination,
    env: restrictedGitEnvironment(),
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive });
  const patch = git(source, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]);
  if (patch) {
    git(destination, ["apply", "--cached", "--binary", "-"], patch);
    git(destination, ["apply", "--binary", "-"], patch);
  }
  copyUntrackedFiles(source, destination);
  git(destination, ["add", "--all"]);
  const tree = gitValue(destination, ["write-tree"]);
  const parent = gitValue(destination, ["rev-parse", "HEAD"]);
  const commit = gitValue(destination, [
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    "Local review snapshot",
  ]);
  git(destination, ["update-ref", "--no-deref", "HEAD", commit]);
  removeSnapshotSymlinks(destination);
  git(destination, ["cat-file", "-e", baseRef + "^{commit}"]);
  return { baseRef, headRef: commit };
}

function assertPublicationPath(
  source: string,
  resource: string,
  options: { destination?: boolean; requireParent?: boolean } = {},
): void {
  const canonicalSource = fs.realpathSync(source);
  const relative = path.relative(canonicalSource, resource);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Artifact publication path escapes the contributor checkout: ${resource}`);
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = canonicalSource;
  const count = options.requireParent ? Math.max(0, parts.length - 1) : parts.length;
  for (const part of parts.slice(0, count)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          `Artifact publication path component must be a directory and not a symbolic link: ${current}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  const existingParent = fs.existsSync(path.dirname(resource))
    ? fs.realpathSync(path.dirname(resource))
    : undefined;
  if (existingParent) {
    const parentRelative = path.relative(canonicalSource, existingParent);
    if (
      parentRelative.startsWith(`..${path.sep}`) ||
      parentRelative === ".." ||
      path.isAbsolute(parentRelative)
    ) {
      throw new Error(`Artifact publication parent escapes the contributor checkout: ${resource}`);
    }
  }
  if (options.destination && fs.existsSync(resource)) {
    const stat = fs.lstatSync(resource);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Existing artifact publication destination must be a directory and not a symbolic link: ${resource}`,
      );
    }
  }
}

function publicationCleanupFailure(resource: string, error: unknown): Error {
  return contextualError(
    `Local review failed during cleanup for artifact publication path ${resource}; remove it manually before retrying`,
    error,
  );
}

function removePublicationPath(
  source: string,
  resource: string,
  publication: LocalReviewPublication,
): unknown {
  try {
    assertPublicationPath(source, resource, { requireParent: true });
    publication.remove(resource, { recursive: true, force: true });
  } catch (error) {
    return publicationCleanupFailure(resource, error);
  }
}

function publishArtifacts(
  source: string,
  artifacts: string,
  destination: string,
  publication: LocalReviewPublication,
): void {
  const nonce = randomUUID();
  const staged = `${destination}.staged-${nonce}`;
  const previous = `${destination}.previous-${nonce}`;
  let failure: unknown;
  let hadPrevious = false;
  const parent = path.dirname(destination);
  assertPublicationPath(source, parent);
  const hadParent = fs.existsSync(parent);
  fs.mkdirSync(parent, { recursive: true });
  assertPublicationPath(source, destination, { destination: true });
  try {
    assertPublicationPath(source, staged, { requireParent: true });
    publication.copy(artifacts, staged, { recursive: true, errorOnExist: true });
    assertPublicationPath(source, destination, { destination: true });
    hadPrevious = fs.existsSync(destination);
    if (hadPrevious) publication.rename(destination, previous);
    assertPublicationPath(source, staged, { destination: true });
    publication.rename(staged, destination);
    if (hadPrevious) {
      assertPublicationPath(source, previous, { destination: true });
      publication.remove(previous, { recursive: true });
    }
    return;
  } catch (error) {
    failure = safeFailure(error);
  }
  failure = combineFailures(failure, removePublicationPath(source, staged, publication));
  if (hadPrevious && fs.existsSync(previous)) {
    failure = combineFailures(failure, removePublicationPath(source, destination, publication));
    try {
      assertPublicationPath(source, previous, { destination: true });
      assertPublicationPath(source, destination, { destination: true, requireParent: true });
      if (!fs.existsSync(destination)) publication.rename(previous, destination);
    } catch (error) {
      failure = combineFailures(
        failure,
        contextualError(
          `Failed to restore prior output from ${previous} to ${destination}; recover it manually`,
          error,
        ),
      );
    }
  }
  if (fs.existsSync(staged)) {
    failure = combineFailures(
      failure,
      new Error(`Residual staged output remains at ${staged}; remove it manually before retrying`),
    );
  }
  if (fs.existsSync(previous)) {
    failure = combineFailures(
      failure,
      new Error(`Prior output remains at ${previous}; restore it to ${destination} manually`),
    );
  }
  if (!hadParent && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
    failure = combineFailures(failure, removePublicationPath(source, parent, publication));
  }
  throw failure;
}

function validateSpecialistArtifacts(outputRoot: string, interest: string): void {
  const directory = path.join(outputRoot, "artifacts", "pr-review-specialist-" + interest);
  const expected = [
    "pr-review-" + interest + "-session.jsonl",
    "pr-review-" + interest + "-summary.md",
  ];
  const actual = fs.readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Specialist artifacts do not match the existing Markdown and JSONL contract");
  }
  for (const name of expected) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Specialist artifact must be a regular file");
  }
}

function specialistEnvironment(input: {
  advisorDirectory: string;
  outputRoot: string;
  runnerTemp: string;
  snapshot: string;
  refs: { baseRef: string; headRef: string };
  specialist: AdvisorSpecialist;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ADVISOR_DIR: input.advisorDirectory,
    ADVISOR_WORKDIR: input.snapshot,
    BASE_REF: input.refs.baseRef,
    GITHUB_WORKSPACE: input.outputRoot,
    HEAD_REF: input.refs.headRef,
    OPENSHELL_GATEWAY_ENDPOINT: LOCAL_OPENSHELL_GATEWAY_ENDPOINT,
    PI_IMAGE: ADVISOR_PI_IMAGE,
    OPENAI_API_KEY: process.env.PR_REVIEW_ADVISOR_API_KEY,
    PR_REVIEW_ADVISOR_ARTIFACT_DIR: "pr-review-specialist-" + input.specialist.interest,
    PR_REVIEW_ADVISOR_INTEREST: input.specialist.interest,
    PR_REVIEW_ADVISOR_MODEL: DEFAULT_ADVISOR_MODEL,
    RUNNER_TEMP: input.runnerTemp,
    SANDBOX_NAME: `lr-${input.specialist.sandboxName.slice(-4)}-${path.basename(input.runnerTemp).slice(-8)}`,
  };
}

export async function runLocalReview(input: {
  source: string;
  specialists?: readonly AdvisorSpecialist[];
  lifecycle?: LocalReviewLifecycle;
  temporaryRoot?: string;
  prepareSnapshot?: typeof createLocalReviewSnapshot;
  advisorDirectory?: string;
  publication?: LocalReviewPublication;
  removeTemporaryRoot?: typeof fs.rmSync;
}): Promise<string> {
  const source = fs.realpathSync(input.source);
  if (!input.lifecycle && !process.env.PR_REVIEW_ADVISOR_API_KEY)
    throw new Error("PR_REVIEW_ADVISOR_API_KEY is required for local review");
  const temporaryRoot =
    input.temporaryRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-review-"));
  const ownsTemporaryRoot = input.temporaryRoot === undefined;
  const advisorDirectory =
    input.advisorDirectory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const snapshot = path.join(temporaryRoot, "pr-workdir");
  const outputRoot = path.join(temporaryRoot, "output");
  const runnerTemp = path.join(temporaryRoot, `runner-${randomUUID().slice(0, 8)}`);
  const lifecycle = input.lifecycle ?? defaultLocalReviewLifecycle;
  const publication = input.publication ?? defaultLocalReviewPublication;
  const removeTemporaryRoot = input.removeTemporaryRoot ?? fs.rmSync;
  let activeLifecycleCleanup: (() => Promise<void>) | undefined;
  let sharedGateway: ReturnType<LocalReviewLifecycle["startGateway"]>;
  let cleanupPromise: Promise<void> | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let result: string | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let failure: unknown;
      try {
        await activeLifecycleCleanup?.();
        activeLifecycleCleanup = undefined;
      } catch (error) {
        failure = safeFailure(error);
      }
      try {
        await sharedGateway?.stop?.();
        sharedGateway = undefined;
      } catch (error) {
        failure = combineFailures(
          failure,
          contextualError("Local review failed during cleanup for gateway", error),
        );
      }
      try {
        if (ownsTemporaryRoot) removeTemporaryRoot(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        failure = combineFailures(
          failure,
          contextualError(
            `Local review failed during cleanup for temporary root ${temporaryRoot}`,
            error,
          ),
        );
      }
      if (failure !== undefined) throw failure;
    })();
    void cleanupPromise.catch(() => {
      cleanupPromise = undefined;
    });
    return cleanupPromise;
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => {
      const resumeSignal = (): void => {
        process.off(signal, handler);
        process.kill(process.pid, signal);
      };
      void cleanup().then(resumeSignal, resumeSignal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.mkdirSync(runnerTemp, { recursive: true });
    const baseCommit = gitValue(source, ["rev-parse", "--verify", "origin/main^{commit}"]);
    const refs = (input.prepareSnapshot ?? createLocalReviewSnapshot)(source, snapshot, baseCommit);
    for (const specialist of input.specialists ?? ADVISOR_SPECIALISTS) {
      const env = specialistEnvironment({
        advisorDirectory,
        outputRoot,
        runnerTemp,
        snapshot,
        refs,
        specialist,
      });
      const specialistLifecycle: LocalReviewLifecycle = {
        ...lifecycle,
        startGateway: (currentEnv) => {
          if (sharedGateway) return undefined;
          sharedGateway = lifecycle.startGateway(currentEnv);
          return sharedGateway;
        },
      };
      await runAdvisorSpecialist({
        env,
        lifecycle: specialistLifecycle,
        cleanupGateway: false,
        validate: () => validateSpecialistArtifacts(outputRoot, specialist.interest),
        setActiveCleanup: (cleanup) => {
          activeLifecycleCleanup = cleanup;
        },
      });
    }
    const destination = path.join(source, LOCAL_OUTPUT_DIRECTORY);
    publishArtifacts(source, path.join(outputRoot, "artifacts"), destination, publication);
    result = destination;
  } catch (error) {
    primaryFailure = safeFailure(error);
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = safeFailure(error);
    if (primaryFailure === undefined) activeLifecycleCleanup = undefined;
  }
  if (primaryFailure !== undefined) {
    if (cleanupFailure !== undefined) {
      const primary = safeFailure(primaryFailure).message;
      const cleanup = safeFailure(cleanupFailure).message;
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        `${primary}; cleanup also failed: ${cleanup}`,
        { cause: primaryFailure },
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result!;
}

async function main(): Promise<void> {
  if (process.argv.length !== 3)
    throw new Error("Trusted local review implementation requires one contributor checkout path");
  console.log("Local specialist reviews: " + (await runLocalReview({ source: process.argv[2]! })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(safeDiagnostic(error));
    process.exit(1);
  });
}
