// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".nemoclaw", "state");

export interface NemoClawState {
  lastRunId: string | null;
  lastAction: string | null;
  blueprintVersion: string | null;
  sandboxName: string | null;
  migrationSnapshot: string | null;
  hostBackupPath: string | null;
  createdAt: string | null;
  updatedAt: string;
  lastRebuildAt: string | null;
  lastRebuildBackupPath: string | null;
}

type UnknownRecord = { [key: string]: unknown };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(value: unknown): string | null | undefined {
  return value === undefined || value === null || typeof value === "string" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStatePatch(value: unknown): Partial<NemoClawState> {
  if (!isRecord(value)) {
    return {};
  }

  const patch: Partial<NemoClawState> = {};

  if (readNullableString(value.lastRunId) !== undefined)
    patch.lastRunId = readNullableString(value.lastRunId);
  if (readNullableString(value.lastAction) !== undefined)
    patch.lastAction = readNullableString(value.lastAction);
  if (readNullableString(value.blueprintVersion) !== undefined)
    patch.blueprintVersion = readNullableString(value.blueprintVersion);
  if (readNullableString(value.sandboxName) !== undefined)
    patch.sandboxName = readNullableString(value.sandboxName);
  if (readNullableString(value.migrationSnapshot) !== undefined)
    patch.migrationSnapshot = readNullableString(value.migrationSnapshot);
  if (readNullableString(value.hostBackupPath) !== undefined)
    patch.hostBackupPath = readNullableString(value.hostBackupPath);
  if (readNullableString(value.createdAt) !== undefined)
    patch.createdAt = readNullableString(value.createdAt);
  if (readString(value.updatedAt) !== undefined) patch.updatedAt = readString(value.updatedAt);
  if (readNullableString(value.lastRebuildAt) !== undefined)
    patch.lastRebuildAt = readNullableString(value.lastRebuildAt);
  if (readNullableString(value.lastRebuildBackupPath) !== undefined)
    patch.lastRebuildBackupPath = readNullableString(value.lastRebuildBackupPath);

  return patch;
}

let stateDirCreated = false;

function ensureStateDir(): void {
  if (stateDirCreated) return;
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  stateDirCreated = true;
}

function statePath(): string {
  return join(STATE_DIR, "nemoclaw.json");
}

function blankState(): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
    lastRebuildAt: null,
    lastRebuildBackupPath: null,
  };
}

export function loadState(): NemoClawState {
  ensureStateDir();
  const path = statePath();
  if (!existsSync(path)) {
    return blankState();
  }

  try {
    // Merge validated persisted values over current defaults so older state
    // files remain compatible as the plugin state schema evolves.
    const persisted: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return { ...blankState(), ...readStatePatch(persisted) };
  } catch {
    return blankState();
  }
}

function writeStateFile(state: NemoClawState): void {
  const finalPath = statePath();
  const tmpPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmpPath, finalPath);
}

export function saveState(state: NemoClawState): void {
  ensureStateDir();
  state.updatedAt = new Date().toISOString();
  state.createdAt ??= state.updatedAt;
  writeStateFile(state);
}

export function clearState(): void {
  ensureStateDir();
  writeStateFile(blankState());
}
