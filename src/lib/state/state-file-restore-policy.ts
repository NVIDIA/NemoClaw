// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface StateFileRestoreSpec {
  path: string;
  strategy: "copy" | "sqlite_backup";
}

export interface StateFileRestorePlan {
  command: string;
  input: Buffer;
}

/** Optional capability for a caller-authorized, file-specific restore plan. */
export type StateFileRestorePolicy = (
  agentType: string | null | undefined,
  dir: string,
  spec: StateFileRestoreSpec,
  backupContents: Buffer,
) => StateFileRestorePlan | null;
