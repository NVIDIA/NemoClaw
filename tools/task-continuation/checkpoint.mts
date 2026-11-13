// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

export interface Checkpoint {
  version: 1;
  revision: number;
  objective: string;
  scope: string;
  authorization: string;
  owner: string;
  handoff?: string;
  identities: Record<string, string>;
  nextAction: string;
  evidence: Array<{ path: string; sha256: string }>;
  operations: Array<{
    id: string;
    action: string;
    budget: string;
    state: "pending" | "observed";
    observation: string;
  }>;
  limits: Record<string, number>;
  // Older records remain readable; the owner must bind their budgets before the next save.
  budgetIdentities?: Record<
    string,
    {
      candidate: string;
      workflow: string;
      failureClass: string;
    }
  >;
}

const text = { type: "string", minLength: 1 };
const validate = new Ajv().compile({
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "revision",
    "objective",
    "scope",
    "authorization",
    "owner",
    "identities",
    "nextAction",
    "evidence",
    "operations",
    "limits",
  ],
  properties: {
    version: { const: 1 },
    revision: { type: "integer", minimum: 0 },
    objective: text,
    scope: text,
    authorization: text,
    owner: text,
    handoff: text,
    nextAction: text,
    identities: { type: "object", minProperties: 1, additionalProperties: text },
    limits: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
    budgetIdentities: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["candidate", "workflow", "failureClass"],
        properties: { candidate: text, workflow: text, failureClass: text },
      },
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "sha256"],
        properties: { path: text, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } },
      },
    },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "action", "budget", "state", "observation"],
        properties: {
          id: text,
          action: text,
          budget: text,
          state: { enum: ["pending", "observed"] },
          observation: { type: "string" },
        },
      },
    },
  },
});

export function parseCheckpoint(value: unknown): Checkpoint {
  if (!validate(value)) throw new Error("Invalid checkpoint schema");
  const state = value as Checkpoint;
  if (state.budgetIdentities) checkBudgetIdentities(state);
  if (state.evidence.some(({ path }) => !isAbsolute(path)))
    throw new Error("Evidence paths must be absolute");
  const ids = new Set<string>();
  const usage = new Map<string, number>();
  for (const operation of state.operations) {
    if (ids.has(operation.id)) throw new Error("Duplicate operation identity");
    ids.add(operation.id);
    if ((operation.state === "observed") !== Boolean(operation.observation.trim()))
      throw new Error("Operation observation does not match state");
    usage.set(operation.budget, (usage.get(operation.budget) ?? 0) + 1);
    if (
      !Object.hasOwn(state.limits, operation.budget) ||
      usage.get(operation.budget)! > state.limits[operation.budget]!
    )
      throw new Error("Operation budget exhausted or missing");
  }
  return state;
}

function budgetIdentity(identity: NonNullable<Checkpoint["budgetIdentities"]>[string]): string {
  const fields = [identity.candidate, identity.workflow, identity.failureClass];
  if (fields.some((field) => !field.trim() || field !== field.trim()))
    throw new Error("Budget identities must use nonempty trimmed fields");
  return JSON.stringify(fields);
}

function checkBudgetIdentities(state: Checkpoint): void {
  const identities = state.budgetIdentities;
  if (!identities || Object.keys(identities).length !== Object.keys(state.limits).length)
    throw new Error("Bind every budget key to its structured identity before saving");
  const seen = new Set<string>();
  for (const key of Object.keys(state.limits)) {
    if (!Object.hasOwn(identities, key))
      throw new Error("Bind every budget key to its structured identity before saving");
    const identity = budgetIdentity(identities[key]!);
    if (seen.has(identity))
      throw new Error("Duplicate budget identity cannot create another allowance");
    seen.add(identity);
  }
}

export function readCheckpoint(file: string): Checkpoint {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Checkpoint must be a regular file");
    return parseCheckpoint(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

function isManualAuthorization(key: string): boolean {
  return (
    key.startsWith("manualE2E.authorization.") ||
    /^manualE2E\.(candidate|base)\.authorization$/.test(key)
  );
}

function checkTransition(previous: Checkpoint, next: Checkpoint, owner: string): void {
  if (previous.owner !== owner)
    throw new Error("Checkpoint owner differs; reconcile ownership before writing");
  if (next.owner !== owner && (!next.handoff || next.handoff === previous.handoff))
    throw new Error("Record a fresh receiving-owner acknowledgement for handoff");
  const addedBudgets = Object.keys(next.limits).filter(
    (key) => !Object.hasOwn(previous.limits, key),
  );
  const appendedAuthorization =
    next.authorization.startsWith(`${previous.authorization}\n`) &&
    Boolean(next.authorization.slice(previous.authorization.length + 1).trim());
  if (next.authorization !== previous.authorization && !appendedAuthorization)
    throw new Error("Existing authorization evidence cannot be rewritten");
  if (addedBudgets.length || !previous.budgetIdentities) {
    if (!appendedAuthorization)
      throw new Error(
        "Record additional authorization evidence before allocating or binding budgets",
      );
  }
  for (const [key, grant] of Object.entries(previous.identities)) {
    if (isManualAuthorization(key) && next.identities[key] !== grant)
      throw new Error("Recorded manual dispatch authorization cannot be removed or rewritten");
  }
  const addedGrants = Object.keys(next.identities).some(
    (key) => isManualAuthorization(key) && !Object.hasOwn(previous.identities, key),
  );
  if (addedGrants && !appendedAuthorization)
    throw new Error("Append authorization evidence before recording a new manual dispatch grant");
  for (const [key, limit] of Object.entries(previous.limits)) {
    if (next.limits[key] !== limit)
      throw new Error("Existing budgets cannot be reset or increased");
    if (
      previous.budgetIdentities &&
      budgetIdentity(previous.budgetIdentities[key]!) !==
        budgetIdentity(next.budgetIdentities![key]!)
    )
      throw new Error("Existing budget identities cannot be rewritten");
  }
  for (const before of previous.operations) {
    const after = next.operations.find(({ id }) => id === before.id);
    if (
      !after ||
      after.action !== before.action ||
      after.budget !== before.budget ||
      (before.state === "observed" &&
        (after.state !== before.state || after.observation !== before.observation))
    )
      throw new Error("Operation history cannot be removed or rewritten");
  }
  const added = next.operations.filter(
    ({ id }) => !previous.operations.some((entry) => entry.id === id),
  );
  if (added.length > 1) throw new Error("Persist only one new operation intent per save");
  if (added.some(({ state }) => state !== "pending"))
    throw new Error("Persist intent before recording an external result");
  if (added.length && previous.operations.some(({ state }) => state === "pending"))
    throw new Error("Reconcile pending operations before another write");
}

// This is a private local journal, not an authorization service or an external dispatcher.
export function saveCheckpoint(
  file: string,
  value: unknown,
  expectedRevision: number,
  owner: string,
): void {
  const next = parseCheckpoint(value);
  checkBudgetIdentities(next);
  const lock = `${file}.lock`;
  const descriptor = openSync(lock, "wx", 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const previous = existsSync(file) ? readCheckpoint(file) : undefined;
    if ((previous?.revision ?? -1) !== expectedRevision || next.revision !== expectedRevision + 1)
      throw new Error("Stale checkpoint revision");
    if (previous) checkTransition(previous, next, owner);
    else if (next.owner !== owner || next.operations.length)
      throw new Error("Initialize an empty operation history for the owner");
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(next, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    const directory = openSync(dirname(resolve(file)), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    unlinkSync(lock);
  }
}

export function resumeCheckpoint(file: string) {
  const state = readCheckpoint(file);
  const staleEvidence = state.evidence
    .filter((entry) => {
      try {
        const fd = openSync(
          entry.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (!fstatSync(fd).isFile()) return true;
          return createHash("sha256").update(readFileSync(fd)).digest("hex") !== entry.sha256;
        } finally {
          closeSync(fd);
        }
      } catch {
        return true;
      }
    })
    .map(({ path }) => path);
  const pending = state.operations.filter(({ state }) => state === "pending");
  return {
    ...state,
    checkpoint: resolve(file),
    usage: Object.fromEntries(
      Object.keys(state.limits).map((key) => [
        key,
        state.operations.filter(({ budget }) => budget === key).length,
      ]),
    ),
    staleEvidence,
    resumeAction: existsSync(`${file}.lock`)
      ? "reconcile-local-writer"
      : pending.length
        ? "reconcile-external-state"
        : staleEvidence.length
          ? "refresh-evidence"
          : "recheck-mutable-state",
    pendingOperationIds: pending.map(({ id }) => id),
  };
}

if (
  import.meta.main ??
  (process.argv[1] !== undefined &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
) {
  try {
    const [command, file, revision, owner] = process.argv.slice(2);
    if (command === "resume" && file && process.argv.length === 4)
      console.log(JSON.stringify(resumeCheckpoint(file), null, 2));
    else if (
      command === "save" &&
      file &&
      owner &&
      /^-?\d+$/.test(revision ?? "") &&
      process.argv.length === 6
    )
      saveCheckpoint(file, JSON.parse(readFileSync(0, "utf8")), Number(revision), owner);
    else
      throw new Error(
        "Usage: checkpoint.mts resume FILE | save FILE EXPECTED_REVISION OWNER < checkpoint.json",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Checkpoint failed");
    process.exitCode = 1;
  }
}
