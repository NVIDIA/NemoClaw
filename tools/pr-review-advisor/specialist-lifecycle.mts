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
  runAdvisorSandbox,
  writeUnavailableAdvisorArtifacts,
} from "./openshell.mts";

export type AdvisorSpecialistLifecycle = {
  prepare: (env: NodeJS.ProcessEnv) => Promise<void>;
  startGateway: (
    env: NodeJS.ProcessEnv,
  ) => { configure: Promise<void>; stop?: () => Promise<void> } | undefined;
  create: (env: NodeJS.ProcessEnv) => void;
  run: (env: NodeJS.ProcessEnv) => void;
  download: (env: NodeJS.ProcessEnv) => void;
  remove: (env: NodeJS.ProcessEnv) => void;
  unavailable?: (env: NodeJS.ProcessEnv, error: unknown) => void;
};

const SECRET_ENVIRONMENT_NAME = /(auth|credential|key|password|secret|token)/iu;
const SECRET_ASSIGNMENT =
  /\b((?:api[_-]?key|credential|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const AUTHORIZATION_CREDENTIAL =
  /\b(authorization\s*[:=]\s*)(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER_CREDENTIAL = /\b(bearer)\s+[^\s,;]+/giu;

function safeDiagnostic(error: unknown): string {
  let detail = error instanceof Error ? error.message : "Unknown non-Error failure";
  for (const [name, value] of Object.entries(process.env)) {
    if (value && SECRET_ENVIRONMENT_NAME.test(name))
      detail = detail.replaceAll(value, "[REDACTED]");
  }
  return detail
    .replace(AUTHORIZATION_CREDENTIAL, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(BEARER_CREDENTIAL, "$1 [REDACTED]");
}

export const defaultAdvisorSpecialistLifecycle: AdvisorSpecialistLifecycle = {
  prepare: prepareAdvisorSandboxInputs,
  startGateway: (env) => ({ configure: configureAdvisorOpenShellInference(env) }),
  create: createAdvisorSandbox,
  run: runAdvisorSandbox,
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
  let primaryFailure: Error | undefined;
  let cleanupFailure: unknown;
  let result: "complete" | "unavailable" = "complete";
  let stage = "prepare";
  const cleanup = async (): Promise<void> => {
    const errors: unknown[] = [];
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
      lifecycle.run(input.env);
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
    if (!primaryFailure || !sandboxActive) input.setActiveCleanup?.(undefined);
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

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  if (command === "prepare") {
    await defaultAdvisorSpecialistLifecycle.prepare(process.env);
    return;
  }
  if (command === "configure") {
    await defaultAdvisorSpecialistLifecycle.startGateway(process.env)?.configure;
    return;
  }
  if (command === "complete" && process.env.CONFIGURE_OUTCOME !== "success") {
    defaultAdvisorSpecialistLifecycle.unavailable?.(
      process.env,
      new Error("Advisor inference is unavailable"),
    );
    if (process.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS !== "0") process.exitCode = 1;
    return;
  }
  await runAdvisorSpecialist({
    env: process.env,
    lifecycle:
      command === "complete"
        ? {
            ...defaultAdvisorSpecialistLifecycle,
            prepare: async () => undefined,
            startGateway: () => ({ configure: Promise.resolve() }),
          }
        : defaultAdvisorSpecialistLifecycle,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(safeDiagnostic(error));
    process.exit(1);
  });
}
