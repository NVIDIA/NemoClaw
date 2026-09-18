// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateManagedImageCohort } from "../e2e/managed-image-cohort-contract.mts";

const RELEASE_PATTERN = /^v[0-9]+(?:\.[0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const NSPECT_ID_PATTERN = /^NSPECT-[A-Z0-9]{4}-[A-Z0-9]{4}$/u;
const NSPECT_MANAGED_IMAGE_REPOSITORIES = {
  openclaw: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
  hermes: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
  "langchain-deepagents-code": "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
} as const;
const NSPECT_MANAGED_IMAGE_AGENTS = Object.keys(
  NSPECT_MANAGED_IMAGE_REPOSITORIES,
) as NspectManagedImageAgent[];

type JsonRecord = Record<string, unknown>;
type NspectManagedImageAgent = keyof typeof NSPECT_MANAGED_IMAGE_REPOSITORIES;

export interface NspectRegistrationPlan {
  readonly kind: "nemoclaw-nspect-registration-plan-v1";
  readonly nspectId: string;
  readonly programVersion: string;
  readonly release: string;
  readonly source: {
    readonly cohort: string;
    readonly revision: string;
    readonly runAttempt: number;
    readonly runId: number;
  };
  readonly containerImages: readonly {
    readonly agent: NspectManagedImageAgent;
    readonly imageUrl: string;
  }[];
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

/** Build the immutable nSpect inputs from one validated tag publication. */
export function buildNspectRegistrationPlan(
  value: unknown,
  expected: {
    readonly nspectId: string;
    readonly programVersion: string;
    readonly release: string;
    readonly revision: string;
    readonly runAttempt: number;
    readonly runId: number;
  },
): NspectRegistrationPlan {
  if (!NSPECT_ID_PATTERN.test(expected.nspectId)) throw new Error("nSpect ID is invalid");
  if (!expected.programVersion || expected.programVersion.trim() !== expected.programVersion) {
    throw new Error("nSpect program version is invalid");
  }
  if (!RELEASE_PATTERN.test(expected.release))
    throw new Error("publication release tag is invalid");

  const receipt = validateManagedImageCohort(value, {
    revision: expected.revision,
    runAttempt: expected.runAttempt,
    runId: expected.runId,
  });
  const cohort = record(value, "managed-image cohort");
  const source = record(cohort.source, "managed-image cohort source");
  if (source.release !== expected.release) {
    throw new Error("managed-image cohort release does not match the source tag");
  }
  const agents = record(cohort.agents, "managed-image cohort agents");
  const containerImages = NSPECT_MANAGED_IMAGE_AGENTS.map((agent) => {
    const contract = record(agents[agent], `${agent} cohort contract`);
    const imageUrl = contract.reference;
    const expectedPrefix = `${NSPECT_MANAGED_IMAGE_REPOSITORIES[agent]}@sha256:`;
    if (typeof imageUrl !== "string" || !imageUrl.startsWith(expectedPrefix)) {
      throw new Error(`${agent} cohort reference is invalid`);
    }
    return { agent, imageUrl };
  });

  return {
    kind: "nemoclaw-nspect-registration-plan-v1",
    nspectId: expected.nspectId,
    programVersion: expected.programVersion,
    release: expected.release,
    source: {
      cohort: receipt.cohort,
      revision: expected.revision,
      runAttempt: expected.runAttempt,
      runId: expected.runId,
    },
    containerImages,
  };
}

export function main(argv = process.argv.slice(2), env = process.env): void {
  if (argv.length !== 1) throw new Error("expected one managed-image cohort contract path");
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const value = JSON.parse(readFileSync(argv[0], "utf8")) as unknown;
  const plan = buildNspectRegistrationPlan(value, {
    nspectId: env.NSPECT_ID ?? "",
    programVersion: env.NSPECT_PROGRAM_VERSION ?? "",
    release: env.PUBLICATION_RELEASE ?? "",
    revision: env.PUBLICATION_HEAD_SHA ?? "",
    runAttempt: requiredInteger(env.PUBLICATION_RUN_ATTEMPT, "PUBLICATION_RUN_ATTEMPT"),
    runId: requiredInteger(env.PUBLICATION_RUN_ID, "PUBLICATION_RUN_ID"),
  });
  appendFileSync(env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\n`, "utf8");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "unknown nSpect registration plan error",
    );
    process.exitCode = 1;
  }
}
