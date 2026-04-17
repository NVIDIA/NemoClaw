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
  // Merge over blankState so that state files created before shields fields
  // were added still return valid NemoClawState with sensible defaults.
  const persisted = JSON.parse(readFileSync(path, "utf-8")) as Partial<NemoClawState>;
  return { ...blankState(), ...persisted };
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
