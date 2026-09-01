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
import { prepareAdvisorSandboxInputs } from "./openshell.mts";
import {
  defaultAdvisorSpecialistLifecycle,
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
  ...defaultAdvisorSpecialistLifecycle,
  prepare: (env) => prepareAdvisorSandboxInputs(env, { collectContext: async () => null }),
};

const gitEnvironment: NodeJS.ProcessEnv = {
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
      .matchAll(/(?:^|\s)filter=([^\s]+)/gmu))
      if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(match[1]!)) names.add(match[1]!);
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
      env: gitEnvironment,
      input,
      maxBuffer: Number.POSITIVE_INFINITY,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
}
const gitValue = (cwd: string, args: readonly string[]): string => git(cwd, args).trim();
function removeSnapshotSymlinks(directory: string): void {
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true }))
    if (entry.isSymbolicLink()) fs.rmSync(path.join(entry.parentPath, entry.name), { force: true });
}
export function createLocalReviewSnapshot(
  source: string,
  destination: string,
  baseRef = gitValue(source, ["rev-parse", "--verify", "origin/main^{commit}"]),
): { baseRef: string; headRef: string } {
  git(path.dirname(destination), ["clone", "--no-hardlinks", "--no-checkout", source, destination]);
  const initialHead = gitValue(destination, ["rev-parse", "HEAD"]);
  git(destination, ["read-tree", initialHead]);
  git(destination, [...disabledFilters(source), "checkout-index", "--all", "--force"]);
  removeSnapshotSymlinks(destination);
  const patch = git(source, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]);
  if (patch) {
    git(destination, ["apply", "--cached", "--binary", "-"], patch);
    git(destination, ["apply", "--binary", "-"], patch);
  }
  for (const relative of git(source, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)) {
    fs.mkdirSync(path.dirname(path.join(destination, relative)), { recursive: true });
    fs.cpSync(path.join(source, relative), path.join(destination, relative), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  git(destination, ["add", "--all"]);
  const commit = gitValue(destination, [
    "commit-tree",
    gitValue(destination, ["write-tree"]),
    "-p",
    initialHead,
    "-m",
    "Local review snapshot",
  ]);
  git(destination, ["update-ref", "--no-deref", "HEAD", commit]);
  removeSnapshotSymlinks(destination);
  git(destination, ["cat-file", "-e", baseRef + "^{commit}"]);
  return { baseRef, headRef: commit };
}

function assertPublicationPath(root: string, resource: string): void {
  root = fs.realpathSync(root);
  const relative = path.relative(root, resource);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error(`Artifact publication path escapes the contributor checkout: ${resource}`);
  for (const part of relative.split(path.sep)) {
    root = path.join(root, part);
    if (!fs.existsSync(root)) return;
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && root !== resource))
      throw new Error(
        `Artifact publication path component must be a directory and not a symbolic link: ${root}`,
      );
  }
}
type StagedPublication = { discard: () => unknown; publish: () => void };
function stageArtifacts(
  source: string,
  artifacts: string,
  destination: string,
  io: LocalReviewPublication,
): StagedPublication {
  const suffix = randomUUID(),
    parent = path.dirname(destination);
  const staged = destination + ".staged-" + suffix,
    previous = destination + ".previous-" + suffix;
  const hadParent = fs.existsSync(parent);
  assertPublicationPath(source, parent);
  fs.mkdirSync(parent, { recursive: true });
  assertPublicationPath(source, destination);
  if (fs.existsSync(destination) && !fs.lstatSync(destination).isDirectory())
    throw new Error(
      `Existing artifact publication destination must be a directory and not a symbolic link: ${destination}`,
    );
  const remove = (resource: string): unknown => {
    try {
      assertPublicationPath(source, resource);
      io.remove(resource, { recursive: true, force: true });
    } catch (error) {
      return contextualError(
        `Failed to remove artifact publication path ${resource}; remove it manually`,
        error,
      );
    }
  };
  const discard = (): unknown => {
    let failure = remove(staged);
    if (!hadParent && fs.existsSync(parent) && fs.readdirSync(parent).length === 0)
      failure = combineFailures(failure, remove(parent));
    if (fs.existsSync(staged))
      failure = combineFailures(
        failure,
        new Error(
          `Residual staged output remains at ${staged}; remove it manually before retrying`,
        ),
      );
    return failure;
  };
  try {
    io.copy(artifacts, staged, { recursive: true, errorOnExist: true });
  } catch (error) {
    throw combineFailures(safeFailure(error), discard());
  }
  return {
    discard,
    publish() {
      const existed = fs.existsSync(destination);
      try {
        assertPublicationPath(source, destination);
        if (existed) io.rename(destination, previous);
        io.rename(staged, destination);
        if (existed) io.remove(previous, { recursive: true });
      } catch (error) {
        let failure = combineFailures(safeFailure(error), remove(staged));
        if (existed && fs.existsSync(previous)) {
          failure = combineFailures(failure, remove(destination));
          try {
            if (!fs.existsSync(destination)) io.rename(previous, destination);
          } catch (restore) {
            failure = combineFailures(
              failure,
              contextualError(
                `Failed to restore prior output from ${previous} to ${destination}; recover it manually`,
                restore,
              ),
            );
          }
        }
        if (fs.existsSync(previous))
          failure = combineFailures(
            failure,
            new Error(`Prior output remains at ${previous}; restore it manually`),
          );
        throw failure;
      }
    },
  };
}

function validateSpecialistArtifacts(root: string, interest: string): void {
  const directory = path.join(root, "artifacts", "pr-review-specialist-" + interest);
  const expected = [`pr-review-${interest}-session.jsonl`, `pr-review-${interest}-summary.md`];
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(expected))
    throw new Error("Specialist artifacts do not match the existing Markdown and JSONL contract");
  if (
    expected.some((name) => {
      const stat = fs.lstatSync(path.join(directory, name));
      return !stat.isFile() || stat.isSymbolicLink();
    })
  )
    throw new Error("Specialist artifact must be a regular file");
}
function specialistEnvironment(
  advisorDirectory: string,
  output: string,
  runnerTemp: string,
  snapshot: string,
  refs: { baseRef: string; headRef: string },
  specialist: AdvisorSpecialist,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ADVISOR_DIR: advisorDirectory,
    ADVISOR_WORKDIR: snapshot,
    BASE_REF: refs.baseRef,
    GITHUB_WORKSPACE: output,
    HEAD_REF: refs.headRef,
    OPENSHELL_GATEWAY_ENDPOINT: LOCAL_OPENSHELL_GATEWAY_ENDPOINT,
    PI_IMAGE: ADVISOR_PI_IMAGE,
    OPENAI_API_KEY: process.env.PR_REVIEW_ADVISOR_API_KEY,
    PR_REVIEW_ADVISOR_ARTIFACT_DIR: "pr-review-specialist-" + specialist.interest,
    PR_REVIEW_ADVISOR_INTEREST: specialist.interest,
    PR_REVIEW_ADVISOR_MODEL: DEFAULT_ADVISOR_MODEL,
    RUNNER_TEMP: runnerTemp,
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
  signals?: {
    listen: (handler: (signal: NodeJS.Signals) => void) => () => void;
    restore: (signal: NodeJS.Signals) => void;
  };
}): Promise<string> {
  const source = fs.realpathSync(input.source);
  if (!input.lifecycle && !process.env.PR_REVIEW_ADVISOR_API_KEY)
    throw new Error("PR_REVIEW_ADVISOR_API_KEY is required for local review");
  const root =
    input.temporaryRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-local-review-"));
  const ownsRoot = input.temporaryRoot === undefined;
  const snapshot = path.join(root, "pr-workdir");
  const output = path.join(root, "output");
  const runnerTemp = path.join(root, "runner");
  const lifecycle = input.lifecycle ?? defaultLocalReviewLifecycle;
  const destination = path.join(source, LOCAL_OUTPUT_DIRECTORY);
  let activeCleanup: (() => Promise<void>) | undefined;
  let staged: StagedPublication | undefined;
  let receivedSignal: NodeJS.Signals | undefined;
  const receiveSignal = (signal: NodeJS.Signals): void => {
    receivedSignal ??= signal;
    void activeCleanup?.().catch(() => undefined);
  };
  const removeHandlers = input.signals
    ? input.signals.listen(receiveSignal)
    : (() => {
        const handlers = new Map<NodeJS.Signals, () => void>();
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
          const handler = (): void => receiveSignal(signal);
          handlers.set(signal, handler);
          process.once(signal, handler);
        }
        return (): void => {
          for (const [signal, handler] of handlers) process.off(signal, handler);
        };
      })();
  let primary: unknown;
  let cleanup: unknown;
  try {
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(runnerTemp, { recursive: true });
    const base = gitValue(source, ["rev-parse", "--verify", "origin/main^{commit}"]);
    const refs = (input.prepareSnapshot ?? createLocalReviewSnapshot)(source, snapshot, base);
    const specialists = input.specialists ?? ADVISOR_SPECIALISTS;
    if (specialists.length > 0) {
      await lifecycle.prepare(
        specialistEnvironment(
          input.advisorDirectory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
          output,
          runnerTemp,
          snapshot,
          refs,
          specialists[0]!,
        ),
      );
    }
    for (const specialist of specialists) {
      await runAdvisorSpecialist({
        env: specialistEnvironment(
          input.advisorDirectory ??
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
          output,
          runnerTemp,
          snapshot,
          refs,
          specialist,
        ),
        lifecycle,
        prepare: false,
        validate: () => validateSpecialistArtifacts(output, specialist.interest),
        setActiveCleanup: (value) => {
          activeCleanup = value;
        },
        cancelled: () => receivedSignal !== undefined,
      });
      if (receivedSignal) break;
    }
    staged = stageArtifacts(
      source,
      path.join(output, "artifacts"),
      destination,
      input.publication ?? defaultLocalReviewPublication,
    );
  } catch (error) {
    primary = safeFailure(error);
  }
  try {
    await activeCleanup?.();
    activeCleanup = undefined;
    if (ownsRoot) (input.removeTemporaryRoot ?? fs.rmSync)(root, { recursive: true, force: true });
  } catch (error) {
    cleanup = contextualError(
      `Local review failed during cleanup for temporary root ${root}`,
      error,
    );
  }
  if (receivedSignal || primary || cleanup) cleanup = combineFailures(cleanup, staged?.discard());
  removeHandlers();
  if (receivedSignal) {
    if (cleanup) console.error(safeDiagnostic(cleanup));
    (input.signals?.restore ?? ((signal) => void process.kill(process.pid, signal)))(
      receivedSignal,
    );
    if (input.signals) return destination;
  }
  if (primary) {
    if (cleanup)
      throw new AggregateError(
        [primary, cleanup],
        safeFailure(primary).message + "; cleanup also failed: " + safeFailure(cleanup).message,
        { cause: primary },
      );
    throw primary;
  }
  if (cleanup) throw cleanup;
  staged!.publish();
  return destination;
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
