// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { GATEWAY_PORT } from "../core/ports";
import { nemoclawStateRoot } from "./state-root";

export const ROOT = path.resolve(__dirname, "..", "..", "..");
export const SCRIPTS = path.join(ROOT, "scripts");

export function resolveNemoclawHomeDir(homeDir: string = process.env.HOME ?? os.homedir()): string {
  return nemoclawStateRoot(homeDir, GATEWAY_PORT);
}

export function resolveNemoclawStateDir(
  homeDir: string = process.env.HOME ?? os.homedir(),
): string {
  return path.join(resolveNemoclawHomeDir(homeDir), "state");
}
