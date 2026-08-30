#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import {
  configureAdvisorOpenShellInference,
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
  run: (env: NodeJS.ProcessEnv) => void | { cancel: () => void; completion: Promise<void> };
  download: (env: NodeJS.ProcessEnv) => void;
  remove: (env: NodeJS.ProcessEnv) => void;
  unavailable?: (env: NodeJS.ProcessEnv, error: unknown) => void;
};

const SECRET_ENVIRONMENT_NAME = /(auth|credential|key|password|secret|token)/iu;
const SECRET_ASSIGNMENT =
  /\b((?:api[_-]?key|credential|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTHORIZATION_CREDENTIAL =
  /\b(authorization\s*[:=]\s*)(?:[^\s,;]+\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER_CREDENTIAL = /\b(bearer)\s+[^\s,;]+/giu;

export function redactAdvisorDiagnostic(detail: string): string {
  let redacted = detail;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && SECRET_ENVIRONMENT_NAME.test(name))
      redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted
    .replace(AUTHORIZATION_CREDENTIAL, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(BEARER_CREDENTIAL, "$1 [REDACTED]");
}

function safeDiagnostic(error: unknown): string {
  return redactAdvisorDiagnostic(
    error instanceof Error ? error.message : "Unknown non-Error failure",
  );
}

export const defaultAdvisorSpecialistLifecycle: AdvisorSpecialistLifecycle = {
  prepare: prepareAdvisorSandboxInputs,
  startGateway: (env) => startAdvisorOpenShellInference(env),
  create: createAdvisorSandbox,
  run: runAdvisorSandboxAsync,
  download: downloadAdvisorArtifacts,
  remove: deleteAdvisorSandbox,
  unavailable: (env, error) =>
    writeUnavailableAdvisorArtifacts({
      ...env,
      PR_REVIEW_ADVISOR_UNAVAILABLE_REASON:
        env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON ?? safeDiagnostic(error),
    }),
};

function stageFailure(stage: string, env: NodeJS.ProcessEnv, cause: unknown): Error {
  const detail = safeDiagnostic(cause);
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
  cleanupGateway?: boolean;
}): Promise<"complete" | "unavailable"> {
  const lifecycle = input.lifecycle ?? defaultAdvisorSpecialistLifecycle;
  let gateway: ReturnType<AdvisorSpecialistLifecycle["startGateway"]> | undefined;
  let sandboxActive = false;
  let execution: { cancel: () => void; completion: Promise<void> } | undefined;
  let primaryFailure: Error | undefined;
  let cleanupFailure: unknown;
  let cleanupPromise: Promise<void> | undefined;
  let result: "complete" | "unavailable" = "complete";
  let stage = "prepare";
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const errors: unknown[] = [];
      if (execution) {
        execution.cancel();
        try {
          await execution.completion;
        } catch {
          // Cancellation is followed by resource cleanup; the primary lifecycle failure owns diagnostics.
        }
        execution = undefined;
      }
      if (sandboxActive) {
        try {
          lifecycle.remove(input.env);
          sandboxActive = false;
        } catch (error) {
          errors.push(stageFailure("cleanup", input.env, error));
        }
      }
      try {
        if (input.cleanupGateway !== false) await gateway?.stop?.();
        gateway = undefined;
      } catch (error) {
        errors.push(stageFailure("gateway cleanup", input.env, error));
      }
      if (errors.length === 1)
        throw new AggregateError(errors, (errors[0] as Error).message, { cause: errors[0] });
      if (errors.length > 1) throw new AggregateError(errors, errors.map(String).join("; "));
    })();
    void cleanupPromise.catch(() => {
      cleanupPromise = undefined;
    });
    return cleanupPromise;
  };
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
      sandboxActive = true;
      lifecycle.create(input.env);
      stage = "run";
      const started = lifecycle.run(input.env);
      if (started) {
        execution = started;
        input.setActiveCleanup?.(cleanup);
        await execution.completion;
        execution = undefined;
      }
      stage = "download";
      lifecycle.download(input.env);
      stage = "validate";
      input.validate?.();
    }
  } catch (error) {
    primaryFailure = stageFailure(stage, input.env, error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailure = error;
    }
    if (!sandboxActive) input.setActiveCleanup?.(undefined);
  }
  if (primaryFailure && cleanupFailure) {
    const cleanup = cleanupFailure as Error;
    throw new AggregateError(
      [primaryFailure, cleanup],
      `${primaryFailure.message}; cleanup also failed: ${cleanup.message}`,
      { cause: primaryFailure },
    );
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}

export async function runAdvisorSpecialistCommand(
  command: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  lifecycle: AdvisorSpecialistLifecycle = defaultAdvisorSpecialistLifecycle,
): Promise<void> {
  if (command === "prepare") {
    await lifecycle.prepare(env);
    return;
  }
  if (command !== "analysis") {
    throw new Error(`Unsupported specialist lifecycle command: ${command ?? "missing"}`);
  }
  if (env.PR_REVIEW_ADVISOR_RUN_ANALYSIS === "0") {
    lifecycle.unavailable?.(env, new Error("Advisor inference is unavailable"));
    return;
  }
  await runAdvisorSpecialist({ env, lifecycle });
}

async function main(): Promise<void> {
  await runAdvisorSpecialistCommand(process.argv[2]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(safeDiagnostic(error));
    process.exit(1);
  });
}
