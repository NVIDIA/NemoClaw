// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export const DUAL_STATION_VLLM_API_KEY_FILE = "dual-station-vllm-api-key";
export const DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE = "dual-station-vllm-runtime.json";

export function discoverDualStationVllmRuntimeReceiptStateDirs(
  sharedStateDir: string,
  gatewaysSubdir: string,
): string[] {
  const gatewaysDir = path.join(sharedStateDir, gatewaysSubdir);
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(gatewaysDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [sharedStateDir];
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Dual-Station vLLM gateway state directory is unsafe: ${gatewaysDir}`);
  }
  const stateDirs = [sharedStateDir];
  for (const entry of fs.readdirSync(gatewaysDir, { withFileTypes: true })) {
    if (!/^\d{1,5}$/.test(entry.name)) continue;
    const port = Number(entry.name);
    if (port < 1 || port > 65535) continue;
    const stateDir = path.join(gatewaysDir, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Dual-Station vLLM legacy gateway state directory is unsafe: ${stateDir}`);
    }
    stateDirs.push(stateDir);
  }
  return stateDirs;
}
