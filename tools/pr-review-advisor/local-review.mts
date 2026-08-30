#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_ADVISOR_MODEL } from "../advisors/provider-constants.mts";
import { ADVISOR_PI_IMAGE, LOCAL_OPENSHELL_GATEWAY_ENDPOINT } from "./runtime-constants.mts";
import {
  configureAdvisorOpenShellInference,
  createAdvisorSandbox,
  deleteAdvisorSandbox,
  downloadAdvisorArtifacts,
  prepareAdvisorSandboxInputs,
  runAdvisorSandbox,
} from "./openshell.mts";
import { ADVISOR_SPECIALISTS, type AdvisorSpecialist } from "./specialist-catalog.mts";

const LOCAL_OUTPUT_DIRECTORY = path.join("artifacts", "pr-review-advisor-local");

export type LocalReviewLifecycle = {
  prepare: (env: NodeJS.ProcessEnv) => Promise<void>;
  configure: (env: NodeJS.ProcessEnv) => Promise<(() => Promise<void>) | void>;
  create: (env: NodeJS.ProcessEnv) => void;
  run: (env: NodeJS.ProcessEnv) => void;
  download: (env: NodeJS.ProcessEnv) => void;
  remove: (env: NodeJS.ProcessEnv) => void;
};

const defaultLifecycle: LocalReviewLifecycle = {
  prepare: (env) => prepareAdvisorSandboxInputs(env, { collectContext: async () => null }),
  configure: configureAdvisorOpenShellInference,
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

export function copyAdvisorCheckout(
  source: string,
  destination: string,
  baseCommit = gitValue(source, ["rev-parse", "--verify", "origin/main^{commit}"]),
): void {
  execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", source, destination], {
    stdio: "pipe",
  });
  git(destination, ["checkout", "--detach", baseCommit]);
  const dependencies = path.join(source, "node_modules");
  if (!fs.statSync(dependencies, { throwIfNoEntry: false })?.isDirectory())
    throw new Error("Run npm install before local review");
  fs.cpSync(dependencies, path.join(destination, "node_modules"), { recursive: true });
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

export async function runLocalReview(
  input: {
    source?: string;
    specialists?: readonly AdvisorSpecialist[];
    lifecycle?: LocalReviewLifecycle;
    temporaryRoot?: string;
    prepareAdvisor?: typeof copyAdvisorCheckout;
    prepareSnapshot?: typeof createLocalReviewSnapshot;
  } = {},
): Promise<string> {
  const source = fs.realpathSync(input.source ?? process.cwd());
  const temporaryRoot =
    input.temporaryRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-review-"));
  const ownsTemporaryRoot = input.temporaryRoot === undefined;
  const advisorDirectory = path.join(temporaryRoot, "advisor");
  const snapshot = path.join(temporaryRoot, "pr-workdir");
  const outputRoot = path.join(temporaryRoot, "output");
  const runnerTemp = path.join(temporaryRoot, `runner-${randomUUID().slice(0, 8)}`);
  const lifecycle = input.lifecycle ?? defaultLifecycle;
  let gatewayCleanup: (() => Promise<void>) | undefined;
  let activeEnvironment: NodeJS.ProcessEnv | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  let result: string | undefined;
  const cleanup = (): Promise<void> =>
    (cleanupPromise ??= (async () => {
      let failure: unknown;
      const environment = activeEnvironment;
      activeEnvironment = undefined;
      try {
        if (environment) lifecycle.remove(environment);
      } catch (error) {
        failure = error;
      }
      const stopGateway = gatewayCleanup;
      gatewayCleanup = undefined;
      try {
        await stopGateway?.();
      } catch (error) {
        failure ??= error;
      }
      try {
        if (ownsTemporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    })());
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
    (input.prepareAdvisor ?? copyAdvisorCheckout)(source, advisorDirectory, baseCommit);
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
        gatewayCleanup ??= (await lifecycle.configure(env)) || undefined;
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
        specialistFailure = new Error(
          `Local review failed during ${stage} for specialist ${specialist.interest}`,
          { cause: error },
        );
      }
      let specialistCleanupFailure: unknown;
      try {
        if (activeEnvironment === env) {
          activeEnvironment = undefined;
          lifecycle.remove(env);
        }
      } catch (error) {
        specialistCleanupFailure = error;
      }
      if (specialistFailure !== undefined) throw specialistFailure;
      if (specialistCleanupFailure !== undefined) throw specialistCleanupFailure;
    }
    const destination = path.join(source, LOCAL_OUTPUT_DIRECTORY);
    const nonce = randomUUID();
    const staged = `${destination}.staged-${nonce}`;
    const previous = `${destination}.previous-${nonce}`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(outputRoot, "artifacts"), staged, { recursive: true, errorOnExist: true });
    const hadPrevious = fs.existsSync(destination);
    if (hadPrevious) fs.renameSync(destination, previous);
    try {
      fs.renameSync(staged, destination);
      if (hadPrevious) fs.rmSync(previous, { recursive: true });
    } catch (error) {
      fs.rmSync(staged, { recursive: true, force: true });
      if (hadPrevious && !fs.existsSync(destination)) fs.renameSync(previous, destination);
      throw error;
    }
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
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result!;
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("review:local does not accept options");
  console.log("Local specialist reviews: " + (await runLocalReview()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
