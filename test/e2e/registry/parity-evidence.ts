// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  defineExecutionProfile,
  type ExecutionAcceleration,
  type ExecutionArchitecture,
  type ExecutionCapability,
  type ExecutionPlatform,
  type ExecutionProviderId,
  type ExecutionRootMode,
} from "./execution-profile.ts";
import { assertResolvedRuntimeCase, type ResolvedRuntimeCase } from "./runtime-matrix.ts";
import {
  assertTerminalMatchesTrace,
  compareCodeUnits,
  type FsmTransition,
  freezeJsonValue,
  type JsonValue,
  normalizeFsmTrace,
  normalizeJsonValue,
  normalizeTerminalOutcome,
  type TerminalOutcome,
} from "./scenario.ts";

export interface ManagedImageEvidence {
  role: string;
  digest: string;
}

export interface ProviderReceipt {
  kind: string;
  operationId: string;
  /** Provider-defined diagnostic payload; parity comparison never interprets it. */
  value: JsonValue;
}

export type NonEmptyProviderReceipts = readonly [ProviderReceipt, ...ProviderReceipt[]];

type NormalizedProviderReceipts = readonly [
  Readonly<ProviderReceipt>,
  ...Readonly<ProviderReceipt>[],
];

export interface NormalizedParityEvidence {
  desiredStateFingerprint: string;
  fsmTrace: readonly Readonly<FsmTransition>[];
  terminalOutcome: Readonly<TerminalOutcome>;
  userVisibleState: JsonValue;
}

export interface ExecutionEvidence {
  schemaVersion: 1;
  caseId: string;
  resultId: string;
  shardId: string;
  scenarioId: string;
  profileId: string;
  source: Readonly<{
    headSha: string;
    baseSha: string;
  }>;
  runtime: Readonly<{
    provider: ExecutionProviderId;
    engineName: string;
    engineVersion: string;
    platform: ExecutionPlatform;
    architecture: ExecutionArchitecture;
    rootMode: ExecutionRootMode;
    acceleration: ExecutionAcceleration;
    capabilities: readonly ExecutionCapability[];
  }>;
  workload: Readonly<{
    logicalId: string;
    providerResourceId: string;
    managedImages: readonly Readonly<ManagedImageEvidence>[];
  }>;
  parity: Readonly<NormalizedParityEvidence>;
  providerReceipts: NormalizedProviderReceipts;
}

export interface ExecutionEvidenceInput {
  resolved: ResolvedRuntimeCase;
  source: {
    headSha: string;
    baseSha: string;
  };
  engine: {
    name: string;
    version: string;
  };
  workload: {
    logicalId: string;
    providerResourceId: string;
    managedImages: readonly ManagedImageEvidence[];
  };
  observed: {
    desiredState: JsonValue;
    fsmTrace: readonly FsmTransition[];
    terminalOutcome: TerminalOutcome;
    userVisibleState: JsonValue;
  };
  providerReceipts: NonEmptyProviderReceipts;
}

export interface ParityMismatch {
  field:
    | "scenarioId"
    | "desiredStateFingerprint"
    | "fsmTrace"
    | "terminalOutcome"
    | "userVisibleState";
  expected: unknown;
  actual: unknown;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RECEIPT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/u;

function normalizeSingleLine(value: string, fieldPath: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/u.test(normalized)) {
    throw new Error(`${fieldPath} must be a non-empty single-line string`);
  }
  return normalized;
}

function stableJson(value: JsonValue): string {
  return JSON.stringify(normalizeJsonValue(value));
}

export function fingerprintDesiredState(desiredState: JsonValue): string {
  return createHash("sha256").update(stableJson(desiredState)).digest("hex");
}

function normalizeSha(value: string, fieldPath: string): string {
  const normalized = value.toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    throw new Error(`${fieldPath} must be a 40-character commit SHA`);
  }
  return normalized;
}

function normalizeManagedImages(
  images: readonly ManagedImageEvidence[],
): readonly Readonly<ManagedImageEvidence>[] {
  if (images.length === 0) {
    throw new Error("workload.managedImages must contain at least one exact image digest");
  }
  const roles = new Set<string>();
  return Object.freeze(
    images
      .map((image) => {
        const role = normalizeSingleLine(image.role, "workload.managedImages.role");
        if (roles.has(role)) {
          throw new Error(`workload.managedImages repeats role '${role}'`);
        }
        roles.add(role);
        const digest = image.digest.toLowerCase();
        if (!IMAGE_DIGEST_PATTERN.test(digest)) {
          throw new Error(`workload.managedImages '${role}' must use an exact sha256 digest`);
        }
        return Object.freeze({ role, digest });
      })
      .sort((left, right) => compareCodeUnits(left.role, right.role)),
  );
}

function normalizeProviderReceipts(receipts: NonEmptyProviderReceipts): NormalizedProviderReceipts {
  if (receipts.length === 0) {
    throw new Error("providerReceipts must contain at least one provider receipt");
  }
  const operationIds = new Set<string>();
  const normalizeReceipt = (receipt: ProviderReceipt): Readonly<ProviderReceipt> => {
    if (typeof receipt.kind !== "string") {
      throw new Error("provider receipt kind must be a string");
    }
    if (typeof receipt.operationId !== "string") {
      throw new Error("provider receipt operationId must be a string");
    }
    if (!RECEIPT_ID_PATTERN.test(receipt.kind)) {
      throw new Error(`provider receipt kind '${receipt.kind}' is invalid`);
    }
    if (!RECEIPT_ID_PATTERN.test(receipt.operationId)) {
      throw new Error(`provider receipt operationId '${receipt.operationId}' is invalid`);
    }
    if (operationIds.has(receipt.operationId)) {
      throw new Error(`provider receipt operationId '${receipt.operationId}' is duplicated`);
    }
    operationIds.add(receipt.operationId);
    return Object.freeze({
      kind: receipt.kind,
      operationId: receipt.operationId,
      value: freezeJsonValue(
        normalizeJsonValue(receipt.value, `providerReceipts.${receipt.operationId}.value`),
      ),
    });
  };
  return Object.freeze([normalizeReceipt(receipts[0]), ...receipts.slice(1).map(normalizeReceipt)]);
}

export function buildExecutionEvidence(input: ExecutionEvidenceInput): ExecutionEvidence {
  assertResolvedRuntimeCase(input.resolved);
  const { case: runtimeCase, shard } = input.resolved;
  const profile = defineExecutionProfile(runtimeCase.profile);
  const logicalId = normalizeSingleLine(input.workload.logicalId, "workload.logicalId");
  if (logicalId !== runtimeCase.identities.sandbox) {
    throw new Error(
      `workload.logicalId '${logicalId}' does not match case sandbox identity '${runtimeCase.identities.sandbox}'`,
    );
  }
  const providerResourceId = normalizeSingleLine(
    input.workload.providerResourceId,
    "workload.providerResourceId",
  );
  const fsmTrace = normalizeFsmTrace(input.observed.fsmTrace);
  const terminalOutcome = normalizeTerminalOutcome(input.observed.terminalOutcome);
  assertTerminalMatchesTrace(fsmTrace, terminalOutcome, "observed.terminalOutcome");
  const desiredState = normalizeJsonValue(input.observed.desiredState, "observed.desiredState");
  const userVisibleState = normalizeJsonValue(
    input.observed.userVisibleState,
    "observed.userVisibleState",
  );
  const assertions = runtimeCase.scenario.assertions;
  const observedContract = {
    desiredState,
    fsmTrace,
    terminalOutcome,
    userVisibleState,
  };
  for (const field of Object.keys(observedContract) as Array<keyof typeof observedContract>) {
    if (!sameJson(observedContract[field], assertions[field])) {
      throw new Error(
        `Runtime case '${runtimeCase.id}' observed ${field} does not satisfy its scenario assertion`,
      );
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    caseId: runtimeCase.id,
    resultId: runtimeCase.identities.result,
    shardId: shard.id,
    scenarioId: runtimeCase.scenario.id,
    profileId: profile.id,
    source: Object.freeze({
      headSha: normalizeSha(input.source.headSha, "source.headSha"),
      baseSha: normalizeSha(input.source.baseSha, "source.baseSha"),
    }),
    runtime: Object.freeze({
      provider: profile.provider,
      engineName: normalizeSingleLine(input.engine.name, "engine.name"),
      engineVersion: normalizeSingleLine(input.engine.version, "engine.version"),
      platform: profile.platform,
      architecture: profile.architecture,
      rootMode: profile.rootMode,
      acceleration: profile.acceleration,
      capabilities: profile.capabilities,
    }),
    workload: Object.freeze({
      logicalId,
      providerResourceId,
      managedImages: normalizeManagedImages(input.workload.managedImages),
    }),
    parity: Object.freeze({
      desiredStateFingerprint: fingerprintDesiredState(desiredState),
      fsmTrace,
      terminalOutcome,
      userVisibleState: freezeJsonValue(userVisibleState),
    }),
    providerReceipts: normalizeProviderReceipts(input.providerReceipts),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function compareParityEvidence(
  expected: ExecutionEvidence,
  actual: ExecutionEvidence,
): ParityMismatch[] {
  const comparable = {
    scenarioId: [expected.scenarioId, actual.scenarioId],
    desiredStateFingerprint: [
      expected.parity.desiredStateFingerprint,
      actual.parity.desiredStateFingerprint,
    ],
    fsmTrace: [expected.parity.fsmTrace, actual.parity.fsmTrace],
    terminalOutcome: [expected.parity.terminalOutcome, actual.parity.terminalOutcome],
    userVisibleState: [expected.parity.userVisibleState, actual.parity.userVisibleState],
  } satisfies Record<ParityMismatch["field"], readonly [unknown, unknown]>;

  return (Object.keys(comparable) as ParityMismatch["field"][]).flatMap((field) => {
    const [expectedValue, actualValue] = comparable[field];
    return sameJson(expectedValue, actualValue)
      ? []
      : [{ field, expected: expectedValue, actual: actualValue }];
  });
}

export function assertParityEvidence(expected: ExecutionEvidence, actual: ExecutionEvidence): void {
  const mismatches = compareParityEvidence(expected, actual);
  if (mismatches.length > 0) {
    throw new Error(
      `Runtime parity mismatch in: ${mismatches.map((mismatch) => mismatch.field).join(", ")}`,
    );
  }
}
