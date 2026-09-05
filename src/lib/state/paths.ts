// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { GATEWAY_PORT } from "../core/ports";
import { REPOSITORY_ROOT } from "../core/repository-root";
import { nemoclawStateRoot } from "./state-root";

export const ROOT = REPOSITORY_ROOT;
export const SCRIPTS = path.join(ROOT, "scripts");

export function resolveNemoclawHomeDir(homeDir: string = process.env.HOME ?? os.homedir()): string {
  return nemoclawStateRoot(homeDir, GATEWAY_PORT);
}

export function resolveNemoclawStateDir(homeDir?: string): string {
  if (
    homeDir === undefined &&
    process.env.VITEST === "true" &&
    (process.env.HOME ?? "") === process.env.NEMOCLAW_TEST_BASE_HOME &&
    process.env.NEMOCLAW_TEST_STATE_DIR &&
    path.isAbsolute(process.env.NEMOCLAW_TEST_STATE_DIR)
  ) {
    return process.env.NEMOCLAW_TEST_STATE_DIR;
  }
  return path.join(resolveNemoclawHomeDir(homeDir), "state");
}

/** Return the validated gateway port that selects this process's NemoClaw state root. */
export function resolveNemoclawStateGatewayPort(): number {
  return GATEWAY_PORT;
}
