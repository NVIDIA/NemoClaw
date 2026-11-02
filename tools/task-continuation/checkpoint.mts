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
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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

export function readCheckpoint(file: string): Checkpoint {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Checkpoint must be a regular file");
    return parseCheckpoint(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

function checkTransition(previous: Checkpoint, next: Checkpoint, owner: string): void {
  if (previous.owner !== owner)
    throw new Error("Checkpoint owner differs; reconcile ownership before writing");
  if (next.owner !== owner && (!next.handoff || next.handoff === previous.handoff))
    throw new Error("Record a fresh receiving-owner acknowledgement for handoff");
  for (const [key, limit] of Object.entries(previous.limits)) {
    if (next.limits[key] !== limit)
      throw new Error("Existing budgets cannot be reset or increased");
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
        return createHash("sha256").update(readFileSync(entry.path)).digest("hex") !== entry.sha256;
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

if (import.meta.main) {
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
