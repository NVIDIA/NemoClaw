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
  startAdvisorOpenShellInference,
  createAdvisorSandbox,
  deleteAdvisorSandbox,
  downloadAdvisorArtifacts,
  prepareAdvisorSandboxInputs,
  runAdvisorSandbox,
} from "./openshell.mts";
import { ADVISOR_SPECIALISTS, type AdvisorSpecialist } from "./specialist-catalog.mts";

const LOCAL_OUTPUT_DIRECTORY = path.join("artifacts", "pr-review-advisor-local");

export type LocalReviewGateway = {
  configure: Promise<void>;
  stop: () => Promise<void>;
};

export type LocalReviewLifecycle = {
  prepare: (env: NodeJS.ProcessEnv) => Promise<void>;
  startGateway: (env: NodeJS.ProcessEnv) => LocalReviewGateway | undefined;
  create: (env: NodeJS.ProcessEnv) => void;
  run: (env: NodeJS.ProcessEnv) => void;
  download: (env: NodeJS.ProcessEnv) => void;
  remove: (env: NodeJS.ProcessEnv) => void;
};

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

function contextualError(message: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${message}: ${detail}`, { cause });
}

function combineFailures(first: unknown, next: unknown): unknown {
  if (next === undefined) return first;
  if (first === undefined) return next;
  return new AggregateError(
    [first, next],
    `${first instanceof Error ? first.message : String(first)}; ${next instanceof Error ? next.message : String(next)}`,
    { cause: first },
  );
}

export const defaultLocalReviewLifecycle: LocalReviewLifecycle = {
  prepare: (env) => prepareAdvisorSandboxInputs(env, { collectContext: async () => null }),
  startGateway: startAdvisorOpenShellInference,
  create: createAdvisorSandbox,
  run: runAdvisorSandbox,
  download: downloadAdvisorArtifacts,
  remove: deleteAdvisorSandbox,
};

function git(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "local-review@localhost",
      GIT_AUTHOR_NAME: "NemoClaw Local Review",
      GIT_COMMITTER_EMAIL: "local-review@localhost",
      GIT_COMMITTER_NAME: "NemoClaw Local Review",
    },
    input,
    maxBuffer: Number.POSITIVE_INFINITY,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
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
  execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", source, destination], {
    stdio: "pipe",
  });
  git(destination, ["checkout", "--detach", "HEAD"]);
  const patch = git(source, ["diff", "--binary", "HEAD"]);
  if (patch) git(destination, ["apply", "--index", "--binary", "-"], patch);
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
  git(destination, ["checkout", "--detach", commit]);
  removeSnapshotSymlinks(destination);
  git(destination, ["cat-file", "-e", baseRef + "^{commit}"]);
  return { baseRef, headRef: commit };
}

function publicationCleanupFailure(resource: string, error: unknown): Error {
  return contextualError(
    `Local review failed during cleanup for artifact publication path ${resource}; remove it manually before retrying`,
    error,
  );
}

function removePublicationPath(resource: string, publication: LocalReviewPublication): unknown {
  try {
    publication.remove(resource, { recursive: true, force: true });
  } catch (error) {
    return publicationCleanupFailure(resource, error);
  }
}

function publishArtifacts(
  artifacts: string,
  destination: string,
  publication: LocalReviewPublication,
): void {
  const nonce = randomUUID();
  const staged = `${destination}.staged-${nonce}`;
  const previous = `${destination}.previous-${nonce}`;
  let failure: unknown;
  let hadPrevious = false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    publication.copy(artifacts, staged, { recursive: true, errorOnExist: true });
    hadPrevious = fs.existsSync(destination);
    if (hadPrevious) publication.rename(destination, previous);
    publication.rename(staged, destination);
    if (hadPrevious) publication.remove(previous, { recursive: true });
    return;
  } catch (error) {
    failure = error;
  }
  failure = combineFailures(failure, removePublicationPath(staged, publication));
  if (hadPrevious && fs.existsSync(previous)) {
    failure = combineFailures(failure, removePublicationPath(destination, publication));
    try {
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
  let gatewayCleanup: (() => Promise<void>) | undefined;
  let activeEnvironment: NodeJS.ProcessEnv | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let result: string | undefined;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let failure: unknown;
      const environment = activeEnvironment;
      try {
        if (environment) lifecycle.remove(environment);
        activeEnvironment = undefined;
      } catch (error) {
        failure = contextualError(
          `Local review failed during cleanup for specialist ${environment?.PR_REVIEW_ADVISOR_INTEREST} in sandbox ${environment?.SANDBOX_NAME}`,
          error,
        );
      }
      const stopGateway = gatewayCleanup;
      try {
        await stopGateway?.();
        gatewayCleanup = undefined;
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
      let specialistFailure: unknown;
      let stage = "prepare";
      try {
        await lifecycle.prepare(env);
        stage = "configure";
        if (!gatewayCleanup) {
          const gateway = lifecycle.startGateway(env);
          gatewayCleanup = gateway?.stop;
          await gateway?.configure;
        }
        stage = "create";
        activeEnvironment = env;
        lifecycle.create(env);
        stage = "run";
        lifecycle.run(env);
        stage = "download";
        lifecycle.download(env);
        stage = "validate";
        validateSpecialistArtifacts(outputRoot, specialist.interest);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        specialistFailure = new Error(
          `Local review failed during ${stage} for specialist ${specialist.interest} in sandbox ${env.SANDBOX_NAME}: ${detail}`,
          { cause: error },
        );
      }
      let specialistCleanupFailure: unknown;
      try {
        if (activeEnvironment === env) {
          lifecycle.remove(env);
          activeEnvironment = undefined;
        }
      } catch (error) {
        specialistCleanupFailure = contextualError(
          `Local review failed during cleanup for specialist ${specialist.interest} in sandbox ${env.SANDBOX_NAME}`,
          error,
        );
      }
      if (specialistFailure !== undefined && specialistCleanupFailure !== undefined) {
        throw new AggregateError(
          [specialistFailure, specialistCleanupFailure],
          `${specialistFailure instanceof Error ? specialistFailure.message : String(specialistFailure)}; cleanup also failed: ${specialistCleanupFailure instanceof Error ? specialistCleanupFailure.message : String(specialistCleanupFailure)}`,
          { cause: specialistFailure },
        );
      }
      if (specialistFailure !== undefined) throw specialistFailure;
      if (specialistCleanupFailure !== undefined) throw specialistCleanupFailure;
    }
    const destination = path.join(source, LOCAL_OUTPUT_DIRECTORY);
    publishArtifacts(path.join(outputRoot, "artifacts"), destination, publication);
    result = destination;
  } catch (error) {
    primaryFailure = error;
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure !== undefined) {
    if (cleanupFailure !== undefined) {
      const primary =
        primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure);
      const cleanup =
        cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
