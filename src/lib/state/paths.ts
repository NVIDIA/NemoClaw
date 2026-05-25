// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..", "..", "..");
export const SCRIPTS = path.join(ROOT, "scripts");

export function resolveNemoclawHomeDir(
  homeDir: string = process.env.HOME ?? os.homedir(),
): string {
  return path.join(homeDir, ".nemoclaw");
}

export function resolveNemoclawStateDir(
  homeDir: string = process.env.HOME ?? os.homedir(),
): string {
  return path.join(resolveNemoclawHomeDir(homeDir), "state");
}
