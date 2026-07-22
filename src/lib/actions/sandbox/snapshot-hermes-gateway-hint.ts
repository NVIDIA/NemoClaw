// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";

/**
 * Recommend a gateway restart after restoring Hermes state files.
 *
 * The restored SQLite databases replace files the running Hermes gateway
 * still holds open, so it serves pre-restore state until it reopens them
 * (#7312).
 */
export function printHermesGatewayRestoreHint(
  sandboxName: string,
  agentName: string | null | undefined,
  restoredFileCount: number,
  writeLine: (message: string) => void = console.log,
): void {
  if (agentName !== "hermes" || restoredFileCount === 0) return;
  writeLine(
    `  Restored state databases are picked up after a gateway restart: run \`${CLI_NAME} ${sandboxName} gateway restart\``,
  );
}
