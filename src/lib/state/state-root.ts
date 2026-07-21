// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../core/ports";

export const STATE_DIR_NAME = ".nemoclaw";
export const GATEWAYS_SUBDIR = "gateways";

export function nemoclawStateRoot(home: string, gatewayPort: number = GATEWAY_PORT): string {
  const base = path.join(home, STATE_DIR_NAME);
  return gatewayPort === DEFAULT_GATEWAY_PORT
    ? base
    : path.join(base, GATEWAYS_SUBDIR, String(gatewayPort));
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || os.homedir();
}

export function getNemoclawStateRoot(home: string = resolveHome()): string {
  return nemoclawStateRoot(home, GATEWAY_PORT);
}
