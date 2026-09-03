#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAdvisorSandbox,
  deleteAdvisorSandbox,
  downloadAdvisorArtifacts,
  prepareAdvisorSandboxInputs,
  runAdvisorSandboxAsync,
  startAdvisorOpenShellInference,
} from "./openshell.mts";
export type AdvisorSpecialistLifecycle = {
  prepare: (env: NodeJS.ProcessEnv) => Promise<void>;
  startGateway: (
    env: NodeJS.ProcessEnv,
  ) => { configure: Promise<void>; stop?: () => Promise<void> } | undefined;
  create: (env: NodeJS.ProcessEnv) => void;
  run: (
    env: NodeJS.ProcessEnv,
  ) => void | { cancel: () => void | Promise<void>; completion: Promise<void> };
  download: (env: NodeJS.ProcessEnv) => void;
  remove: (env: NodeJS.ProcessEnv) => void;
};
const SECRET_NAME = /(auth|credential|key|password|secret|token)/iu;
const SECRET_VALUE =
  /\b((?:api[_-]?key|credential|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTH_VALUE = /\b(authorization\s*[:=]\s*)(?:[^\s,;]+\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER = /\b(bearer)\s+[^\s,;]+/giu;
export function redactAdvisorDiagnostic(detail: string): string {
  for (const [name, value] of Object.entries(process.env))
    if (value && SECRET_NAME.test(name)) detail = detail.replaceAll(value, "[REDACTED]");
  return detail
    .replace(AUTH_VALUE, "$1[REDACTED]")
    .replace(SECRET_VALUE, "$1[REDACTED]")
    .replace(BEARER, "$1 [REDACTED]");
}
function diagnostic(error: unknown): string {
  return redactAdvisorDiagnostic(
    error instanceof Error ? error.message : "Unknown non-Error failure",
  );
}
export const defaultAdvisorSpecialistLifecycle: AdvisorSpecialistLifecycle = {
  prepare: prepareAdvisorSandboxInputs,
  startGateway: startAdvisorOpenShellInference,
  create: createAdvisorSandbox,
  run: runAdvisorSandboxAsync,
  download: downloadAdvisorArtifacts,
  remove: deleteAdvisorSandbox,
};
function failure(stage: string, env: NodeJS.ProcessEnv, cause: unknown): Error {
  const detail = diagnostic(cause);
  return new Error(
    `Local review failed during ${stage} for specialist ${env.PR_REVIEW_ADVISOR_INTEREST ?? "advisor"} in sandbox ${env.SANDBOX_NAME ?? "unknown"}: ${detail}`,
    { cause: new Error(detail) },
  );
}
export async function runAdvisorSpecialist(input: {
  env: NodeJS.ProcessEnv;
  lifecycle?: AdvisorSpecialistLifecycle;
  prepare?: boolean;
  validate?: () => void;
  setActiveCleanup?: (cleanup: (() => Promise<void>) | undefined) => void;
  cancelled?: () => boolean;
}): Promise<"complete" | "cancelled"> {
  const lifecycle = input.lifecycle ?? defaultAdvisorSpecialistLifecycle;
  const env = {
    ...input.env,
    SANDBOX_NAME: `pr-adv-${randomBytes(6).toString("hex")}`,
  };
  let gateway: ReturnType<AdvisorSpecialistLifecycle["startGateway"]>;
  let sandbox = false;
  let execution: Exclude<ReturnType<AdvisorSpecialistLifecycle["run"]>, void> | undefined;
  let settleCancellation: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let stage = "prepare";
  const cleanup = (): Promise<void> =>
    (cleanupPromise ??= Promise.resolve()
      .then(async () => {
        const errors: Error[] = [];
        if (execution) {
          try {
            await execution.cancel();
          } catch (error) {
            errors.push(failure("execution cleanup", env, error));
          } finally {
            settleCancellation?.();
            settleCancellation = undefined;
            execution = undefined;
          }
        }
        if (sandbox) {
          try {
            lifecycle.remove(env);
            sandbox = false;
          } catch (error) {
            errors.push(failure("cleanup", env, error));
          }
        }
        try {
          await gateway?.stop?.();
          gateway = undefined;
        } catch (error) {
          errors.push(failure("gateway cleanup", env, error));
        }
        if (errors.length)
          throw new AggregateError(errors, errors.map((error) => error.message).join("; "), {
            cause: errors[0],
          });
      })
      .catch((error) => {
        cleanupPromise = undefined;
        throw error;
      }));
  let primary: Error | undefined;
  let cleanupError: unknown;
  let result: "complete" | "cancelled" = "complete";
  try {
    if (input.prepare !== false) await lifecycle.prepare(env);
    if (input.cancelled?.()) result = "cancelled";
    stage = "configure";
    if (result === "complete") gateway = lifecycle.startGateway(env);
    input.setActiveCleanup?.(cleanup);
    await gateway?.configure;
    if (input.cancelled?.()) result = "cancelled";
    if (result === "complete") {
      stage = "create";
      // The cryptographically unique name is owned by this invocation before creation starts,
      // so cleanup can reconcile a sandbox left by a partially failed create command.
      sandbox = true;
      lifecycle.create(env);
      stage = "run";
      execution = lifecycle.run(env) || undefined;
      if (execution) {
        const cancellation = new Promise<"cancelled">(
          (resolve) => (settleCancellation = () => resolve("cancelled")),
        );
        const completion = execution.completion.then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        const settled = await Promise.race([completion, cancellation]);
        if (settled === "cancelled" || input.cancelled?.()) result = "cancelled";
        else {
          execution = undefined;
          settleCancellation = undefined;
          if (settled.error) throw settled.error;
        }
      }
      if (input.cancelled?.()) result = "cancelled";
      if (result === "complete") {
        stage = "download";
        lifecycle.download(env);
        stage = "validate";
        input.validate?.();
      }
    }
  } catch (error) {
    primary = failure(stage, env, error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (!sandbox) input.setActiveCleanup?.(undefined);
  }
  if (primary && cleanupError)
    throw new AggregateError(
      [primary, cleanupError],
      `${primary.message}; cleanup also failed: ${(cleanupError as Error).message}`,
      { cause: primary },
    );
  if (primary) throw primary;
  if (cleanupError) throw cleanupError;
  return result;
}
export function publishSpecialistJobSummary(env: NodeJS.ProcessEnv): void {
  const interest = env.PR_REVIEW_ADVISOR_INTEREST;
  const artifactDirectory = env.PR_REVIEW_ADVISOR_ARTIFACT_DIR;
  const workspace = env.GITHUB_WORKSPACE;
  const jobSummary = env.GITHUB_STEP_SUMMARY;
  if (!interest || !artifactDirectory || !workspace || !jobSummary) {
    throw new Error(
      "Hosted specialist summary publication requires its interest, artifact directory, workspace, and job summary path",
    );
  }
  const summary = path.join(
    workspace,
    "artifacts",
    artifactDirectory,
    `pr-review-${interest}-summary.md`,
  );
  const descriptor = fs.openSync(summary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("Specialist job summary source must be a regular file");
    }
    fs.appendFileSync(jobSummary, fs.readFileSync(descriptor));
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function runAdvisorSpecialistCommand(
  command: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  lifecycle: AdvisorSpecialistLifecycle = defaultAdvisorSpecialistLifecycle,
  signals: {
    listen: (handler: (signal: NodeJS.Signals) => void) => () => void;
    restore: (signal: NodeJS.Signals) => void;
  } = {
    listen: (receive) => {
      const handlers = new Map<NodeJS.Signals, () => void>();
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        const handler = (): void => receive(signal);
        handlers.set(signal, handler);
        process.once(signal, handler);
      }
      return () => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
      };
    },
    restore: (signal) => process.kill(process.pid, signal),
  },
): Promise<void> {
  if (command === "prepare") return lifecycle.prepare(env);
  if (command !== "analysis")
    throw new Error(`Unsupported specialist lifecycle command: ${command ?? "missing"}`);
  let received: NodeJS.Signals | undefined;
  let activeCleanup: (() => Promise<void>) | undefined;
  let cancellationFailure: unknown;
  const removeHandlers = signals.listen((signal) => {
    received ??= signal;
    void activeCleanup?.().catch((error) => (cancellationFailure ??= error));
  });
  try {
    const result = await runAdvisorSpecialist({
      env,
      lifecycle,
      prepare: false,
      setActiveCleanup: (cleanup) => {
        activeCleanup = cleanup;
        if (received) void cleanup?.().catch((error) => (cancellationFailure ??= error));
      },
      cancelled: () => received !== undefined,
    });
    if (result === "complete" && received === undefined && env.GITHUB_STEP_SUMMARY)
      publishSpecialistJobSummary(env);
  } catch (error) {
    cancellationFailure ??= error;
    if (!received) throw error;
  } finally {
    removeHandlers();
  }
  if (received) {
    if (cancellationFailure)
      console.error(
        `Received ${received}; residual advisor resource cleanup failed: ${diagnostic(cancellationFailure)}`,
      );
    signals.restore(received);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runAdvisorSpecialistCommand(process.argv[2]).catch((error) => {
    console.error(diagnostic(error));
    process.exit(1);
  });
