// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = "langchain-deepagents-code";
const IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
const PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export const DCODE_BASE_IMAGE_TARGET_PLATFORM = "linux/amd64" as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const IMPORT_MARKER = "nemoclaw-dcode-base-imports-ok";

type JsonRecord = Record<string, unknown>;
export type DcodePlatform = (typeof PLATFORMS)[number];

export interface DcodeBaseImageContract {
  contractVersion: 1;
  agent: typeof AGENT;
  image: typeof IMAGE;
  digest: string;
  reference: string;
  platforms: typeof PLATFORMS;
  platformDigests: Record<DcodePlatform, string>;
  platformReferences: Record<DcodePlatform, string>;
  sourceRevision: string;
  run: { id: number; attempt: number };
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has unexpected fields`);
  }
}

export function parseDcodeBaseImageContract(value: unknown): DcodeBaseImageContract {
  const contract = record(value, "Deep Agents Code base contract");
  exactKeys(
    contract,
    [
      "agent",
      "contractVersion",
      "digest",
      "image",
      "platformDigests",
      "platformReferences",
      "platforms",
      "reference",
      "run",
      "sourceRevision",
    ],
    "Deep Agents Code base contract",
  );
  if (contract.contractVersion !== 1) throw new Error("base contract version must be 1");
  if (contract.agent !== AGENT) throw new Error(`base contract agent must be ${AGENT}`);
  if (contract.image !== IMAGE) throw new Error(`base contract image must be ${IMAGE}`);
  if (typeof contract.digest !== "string" || !DIGEST_PATTERN.test(contract.digest)) {
    throw new Error("base contract digest must be an immutable SHA-256 digest");
  }
  if (contract.reference !== `${IMAGE}@${contract.digest}`) {
    throw new Error("base contract reference must match its image and digest");
  }
  if (typeof contract.sourceRevision !== "string" || !SHA_PATTERN.test(contract.sourceRevision)) {
    throw new Error("base contract source revision must be a lowercase 40-character SHA");
  }
  if (
    !Array.isArray(contract.platforms) ||
    JSON.stringify(contract.platforms) !== JSON.stringify(PLATFORMS)
  ) {
    throw new Error("base contract platforms must be linux/amd64 and linux/arm64");
  }
  const platformDigests = record(contract.platformDigests, "base contract platform digests");
  const platformReferences = record(
    contract.platformReferences,
    "base contract platform references",
  );
  exactKeys(platformDigests, contract.platforms, "base contract platform digests");
  exactKeys(platformReferences, contract.platforms, "base contract platform references");
  for (const platform of contract.platforms) {
    const digest = platformDigests[platform];
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
      throw new Error(`base contract ${platform} digest is invalid`);
    }
    if (platformReferences[platform] !== `${IMAGE}@${digest}`) {
      throw new Error(`base contract ${platform} reference is invalid`);
    }
  }
  const run = record(contract.run, "base contract run");
  exactKeys(run, ["attempt", "id"], "base contract run");
  positiveInteger(run.id, "base contract run id");
  positiveInteger(run.attempt, "base contract run attempt");
  return contract as unknown as DcodeBaseImageContract;
}

export function validateDcodeBaseImageContract(
  value: unknown,
  expected: { runId: number; runAttempt: number; headSha: string; baseReference?: string },
): DcodeBaseImageContract {
  if (!SHA_PATTERN.test(expected.headSha)) {
    throw new Error("base contract source revision does not match the selected publication");
  }
  const contract = parseDcodeBaseImageContract(value);
  if (contract.sourceRevision !== expected.headSha) {
    throw new Error("base contract source revision does not match the selected publication");
  }
  if (contract.run.id !== expected.runId || contract.run.attempt !== expected.runAttempt) {
    throw new Error("base contract run does not match the selected publication");
  }
  if (
    expected.baseReference !== undefined &&
    contract.platformReferences[DCODE_BASE_IMAGE_TARGET_PLATFORM] !== expected.baseReference
  ) {
    throw new Error("base contract reference does not match the exact PR managed image");
  }
  return contract;
}

export function validateDcodeBaseImageImports(
  reference: string,
  runDocker: (args: string[]) => string = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).trim(),
): void {
  const output = runDocker([
    "run",
    "--rm",
    "--platform",
    DCODE_BASE_IMAGE_TARGET_PLATFORM,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--user",
    "999:999",
    "--entrypoint",
    "/opt/venv/bin/python3",
    reference,
    "-I",
    "-c",
    `import deepagents; import deepagents_code; print("${IMPORT_MARKER}")`,
  ]);
  if (output.trim() !== IMPORT_MARKER) {
    throw new Error("immutable Deep Agents Code base did not prove both required imports");
  }
}

function requiredInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value))
    throw new Error(`${label} must be a positive integer`);
  return positiveInteger(Number(value), label);
}

export function main(
  argv = process.argv.slice(2),
  env = process.env,
  runDocker?: (args: string[]) => string,
): void {
  if (argv.length !== 1) throw new Error("expected one managed base contract path");
  const outputPath = env.GITHUB_OUTPUT ?? "";
  if (!outputPath || outputPath.includes("\r") || outputPath.includes("\n")) {
    throw new Error("GITHUB_OUTPUT must be a non-empty single-line path");
  }
  const contract = validateDcodeBaseImageContract(
    JSON.parse(readFileSync(resolve(argv[0]), "utf8")) as unknown,
    {
      runId: requiredInteger(env.PUBLICATION_RUN_ID, "PUBLICATION_RUN_ID"),
      runAttempt: requiredInteger(env.PUBLICATION_RUN_ATTEMPT, "PUBLICATION_RUN_ATTEMPT"),
      headSha: env.PUBLICATION_HEAD_SHA ?? "",
      baseReference: env.EXPECTED_BASE_REF?.trim() || undefined,
    },
  );
  const baseReference = contract.platformReferences[DCODE_BASE_IMAGE_TARGET_PLATFORM];
  validateDcodeBaseImageImports(baseReference, runDocker);
  appendFileSync(
    outputPath,
    `base_ref=${baseReference}\ncontract=${JSON.stringify(contract)}\n`,
    "utf8",
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown DCode base contract error");
    process.exitCode = 1;
  }
}
