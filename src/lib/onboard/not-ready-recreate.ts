// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface NotReadyRecreateInput {
  sandboxName: string;
  installerRestoreOnRecreate: boolean;
  latestBackupPath: string | null;
}

export type NotReadyRecreateDecision =
  | { kind: "exit" }
  | {
      kind: "recreate";
      restoreBackupPath: string | null;
      note: string;
    };

export function decideNonInteractiveNotReadyAction(
  input: NotReadyRecreateInput,
): NotReadyRecreateDecision {
  if (!input.installerRestoreOnRecreate) {
    return { kind: "exit" };
  }
  if (input.latestBackupPath) {
    return {
      kind: "recreate",
      restoreBackupPath: input.latestBackupPath,
      note: `  Sandbox '${input.sandboxName}' exists but is not ready — recreating and restoring pre-upgrade backup.`,
    };
  }
  return {
    kind: "recreate",
    restoreBackupPath: null,
    note: `  Sandbox '${input.sandboxName}' exists but is not ready — recreating (no pre-upgrade backup found).`,
  };
}
