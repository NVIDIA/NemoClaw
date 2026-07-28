// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

export const RISK_SIGNAL_FILE = "risk-signal.json";

export type E2eRiskSignal = {
  version: 1;
  jobId: string;
  shardId: string;
  expectedSha: string;
  testedSha: string;
  planHash: string;
  correlationId: string;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  unhandledErrors: number;
  runReason: "passed" | "failed" | "interrupted";
};

export type RiskSignalEnvironment = {
  artifactDir: string;
  jobId: string;
  shardId: string;
  expectedSha: string;
  testedSha: string;
  planHash: string;
  correlationId: string;
};

export type RiskSignalCounts = Pick<
  E2eRiskSignal,
  "passed" | "failed" | "skipped" | "pending" | "unhandledErrors" | "runReason"
>;

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CORRELATION_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SHARD_PATTERN = /^(?:default|[A-Za-z0-9][A-Za-z0-9_-]*)$/u;

function checkedOutSha(workspace: string): string {
  return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  }).trim();
}

export function configuredRiskSignalEnvironment(
  env: NodeJS.ProcessEnv,
  resolveHead: (workspace: string) => string = checkedOutSha,
): RiskSignalEnvironment | null {
  if (!env.NEMOCLAW_E2E_EXPECTED_SHA) return null;
  const values = {
    artifactDir: env.E2E_ARTIFACT_DIR ?? "",
    jobId: env.E2E_TARGET_ID ?? "",
    shardId: env.NEMOCLAW_E2E_SHARD ?? "",
    expectedSha: env.NEMOCLAW_E2E_EXPECTED_SHA,
    planHash: env.NEMOCLAW_E2E_PLAN_HASH ?? "",
    correlationId: env.NEMOCLAW_E2E_CORRELATION_ID ?? "",
  };
  if (!values.artifactDir) throw new Error("risk signal requires E2E_ARTIFACT_DIR");
  if (!JOB_PATTERN.test(values.jobId)) throw new Error("risk signal requires a safe E2E_TARGET_ID");
  if (!SHARD_PATTERN.test(values.shardId)) {
    throw new Error("risk signal requires a safe shard id");
  }
  if (!SHA_PATTERN.test(values.expectedSha)) {
    throw new Error("risk signal requires a 40-character lowercase expected SHA");
  }
  if (!HASH_PATTERN.test(values.planHash)) {
    throw new Error("risk signal requires a 64-character lowercase plan hash");
  }
  if (!CORRELATION_PATTERN.test(values.correlationId)) {
    throw new Error("risk signal requires a lowercase UUIDv4 correlation id");
  }
  const testedSha = resolveHead(env.GITHUB_WORKSPACE ?? process.cwd());
  if (!SHA_PATTERN.test(testedSha) || testedSha !== values.expectedSha) {
    throw new Error("risk signal checked-out HEAD does not match the expected SHA");
  }
  return { ...values, testedSha };
}

export function buildRiskSignal(
  environment: RiskSignalEnvironment,
  counts: RiskSignalCounts,
): E2eRiskSignal {
  return {
    version: 1,
    jobId: environment.jobId,
    shardId: environment.shardId,
    expectedSha: environment.expectedSha,
    testedSha: environment.testedSha,
    planHash: environment.planHash,
    correlationId: environment.correlationId,
    ...counts,
  };
}
