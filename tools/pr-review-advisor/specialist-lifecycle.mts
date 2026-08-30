#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";
import {
  createAdvisorSandbox,
  deleteAdvisorSandbox,
  downloadAdvisorArtifacts,
  prepareAdvisorSandboxInputs,
  runAdvisorSandboxAsync,
  startAdvisorOpenShellInference,
  writeUnavailableAdvisorArtifacts,
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
  unavailable?: (env: NodeJS.ProcessEnv, error: unknown) => void;
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
  unavailable: (env, error) =>
    writeUnavailableAdvisorArtifacts({
      ...env,
      PR_REVIEW_ADVISOR_UNAVAILABLE_REASON:
        env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON ?? diagnostic(error),
    }),
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
  unavailableIsSuccess?: boolean;
  validate?: () => void;
  setActiveCleanup?: (cleanup: (() => Promise<void>) | undefined) => void;
}): Promise<"complete" | "unavailable"> {
  const lifecycle = input.lifecycle ?? defaultAdvisorSpecialistLifecycle;
  let gateway: ReturnType<AdvisorSpecialistLifecycle["startGateway"]>;
  let sandbox = false;
  let execution: Exclude<ReturnType<AdvisorSpecialistLifecycle["run"]>, void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let stage = "prepare";
  const cleanup = (): Promise<void> =>
    (cleanupPromise ??= (async () => {
      const errors: Error[] = [];
      if (execution) {
        try {
          await (execution.cancel() ?? execution.completion);
        } catch (error) {
          errors.push(failure("execution cleanup", input.env, error));
        }
        execution = undefined;
      }
      if (sandbox) {
        try {
          lifecycle.remove(input.env);
          sandbox = false;
        } catch (error) {
          errors.push(failure("cleanup", input.env, error));
        }
      }
      try {
        await gateway?.stop?.();
        gateway = undefined;
      } catch (error) {
        errors.push(failure("gateway cleanup", input.env, error));
      }
      if (errors.length)
        throw new AggregateError(errors, errors.map((error) => error.message).join("; "), {
          cause: errors[0],
        });
    })().catch((error) => {
      cleanupPromise = undefined;
      throw error;
    }));
  let primary: Error | undefined;
  let cleanupError: unknown;
  let result: "complete" | "unavailable" = "complete";
  try {
    await lifecycle.prepare(input.env);
    stage = "configure";
    gateway = lifecycle.startGateway(input.env);
    input.setActiveCleanup?.(cleanup);
    try {
      await gateway?.configure;
    } catch (error) {
      lifecycle.unavailable?.(input.env, error);
      if (input.unavailableIsSuccess) result = "unavailable";
      else throw error;
    }
    if (result === "complete") {
      stage = "create";
      sandbox = true;
      lifecycle.create(input.env);
      stage = "run";
      execution = lifecycle.run(input.env) || undefined;
      input.setActiveCleanup?.(cleanup);
      if (execution) {
        await execution.completion;
        execution = undefined;
      }
      stage = "download";
      lifecycle.download(input.env);
      stage = "validate";
      input.validate?.();
    }
  } catch (error) {
    primary = failure(stage, input.env, error);
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
export async function runAdvisorSpecialistCommand(
  command: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  lifecycle: AdvisorSpecialistLifecycle = defaultAdvisorSpecialistLifecycle,
): Promise<void> {
  if (command === "prepare") return lifecycle.prepare(env);
  if (command !== "analysis")
    throw new Error(`Unsupported specialist lifecycle command: ${command ?? "missing"}`);
  if (env.PR_REVIEW_ADVISOR_RUN_ANALYSIS === "0") {
    lifecycle.unavailable?.(env, new Error("Advisor inference is unavailable"));
    return;
  }
  await runAdvisorSpecialist({ env, lifecycle });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runAdvisorSpecialistCommand(process.argv[2]).catch((error) => {
    console.error(diagnostic(error));
    process.exit(1);
  });
