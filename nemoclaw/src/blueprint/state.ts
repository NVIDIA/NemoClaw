// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  // Shields state (RFC: Sandbox Management Commands, Phase 1)
  shieldsDown: boolean;
  shieldsDownAt: string | null;
  shieldsDownTimeout: number | null;
  shieldsDownReason: string | null;
  shieldsDownPolicy: string | null;
  shieldsPolicySnapshotPath: string | null;
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNullableNumber(value: unknown): number | null | undefined {
  return value === undefined || value === null || typeof value === "number" ? value : undefined;
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
  if (readBoolean(value.shieldsDown) !== undefined)
    patch.shieldsDown = readBoolean(value.shieldsDown);
  if (readNullableString(value.shieldsDownAt) !== undefined)
    patch.shieldsDownAt = readNullableString(value.shieldsDownAt);
  if (readNullableNumber(value.shieldsDownTimeout) !== undefined)
    patch.shieldsDownTimeout = readNullableNumber(value.shieldsDownTimeout);
  if (readNullableString(value.shieldsDownReason) !== undefined)
    patch.shieldsDownReason = readNullableString(value.shieldsDownReason);
  if (readNullableString(value.shieldsDownPolicy) !== undefined)
    patch.shieldsDownPolicy = readNullableString(value.shieldsDownPolicy);
  if (readNullableString(value.shieldsPolicySnapshotPath) !== undefined)
    patch.shieldsPolicySnapshotPath = readNullableString(value.shieldsPolicySnapshotPath);

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
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    shieldsPolicySnapshotPath: null,
  };
}

export function loadState(): NemoClawState {
  ensureStateDir();
  const path = statePath();
  if (!existsSync(path)) {
    return blankState();
  }

  try {
    // Merge over blankState so that state files created before shields fields
    // were added still return valid NemoClawState with sensible defaults.
    const persisted: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return { ...blankState(), ...readStatePatch(persisted) };
  } catch {
    return blankState();
  }
}

export function saveState(state: NemoClawState): void {
  ensureStateDir();
  state.updatedAt = new Date().toISOString();
  state.createdAt ??= state.updatedAt;
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

export function clearState(): void {
  ensureStateDir();
  const path = statePath();
  if (existsSync(path)) {
    writeFileSync(path, JSON.stringify(blankState(), null, 2));
  }
}
