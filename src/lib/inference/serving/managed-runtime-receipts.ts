// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listGatewayStateRoots } from "../../state/gateway-registry";
import { managedVllmStateDir } from "../vllm-api-key";
import { DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE } from "../vllm-station-runtime-receipt-path";
import {
  DUAL_SPARK_MANAGED_SERVING_STATE_FILE,
  DUAL_SPARK_VLLM_RUNTIME_RECEIPT_FILE,
} from "./spark-runtime-receipt-path";

export { MCP_LIFECYCLE_LOCK_DIRNAME } from "../../state/mcp-lifecycle-lock-storage";
export { MANAGED_VLLM_API_KEY_FILE } from "../vllm-api-key";
export { DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE } from "../vllm-station-runtime-receipt-path";
export {
  DUAL_SPARK_MANAGED_SERVING_STATE_FILE,
  DUAL_SPARK_VLLM_RUNTIME_RECEIPT_FILE,
} from "./spark-runtime-receipt-path";

export interface ManagedDistributedVllmRuntimeReceipts {
  readonly sparkBindingPath: string | null;
  readonly sparkDiscoveryBindingPaths: readonly string[];
  readonly sparkPath: string | null;
  readonly stationBindingPaths: readonly string[];
  readonly stationPaths: readonly string[];
}

function pathExistsNoFollow(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Locate durable distributed-runtime ownership without parsing or following receipt paths. */
export function findManagedDistributedVllmRuntimeReceipts(
  options: { readonly homeDir?: string } = {},
): ManagedDistributedVllmRuntimeReceipts {
  const homeDir = options.homeDir ?? os.homedir();
  const stateRoots = listGatewayStateRoots(homeDir);
  const sparkPath = path.join(managedVllmStateDir(homeDir), DUAL_SPARK_VLLM_RUNTIME_RECEIPT_FILE);
  const stationPaths = stateRoots
    .map(({ root }) => path.join(root, DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE))
    .filter(pathExistsNoFollow);
  const sparkBindingPath = `${sparkPath}.ssh-binding`;
  const sparkDiscoveryBindingPaths = stateRoots
    .map(({ root }) => `${path.join(root, DUAL_SPARK_MANAGED_SERVING_STATE_FILE)}.ssh-binding`)
    .filter(pathExistsNoFollow);
  const stationBindingPaths = stateRoots
    .map(({ root }) => `${path.join(root, DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE)}.ssh-binding`)
    .filter(pathExistsNoFollow);
  return {
    sparkBindingPath: pathExistsNoFollow(sparkBindingPath) ? sparkBindingPath : null,
    sparkDiscoveryBindingPaths,
    sparkPath: pathExistsNoFollow(sparkPath) ? sparkPath : null,
    stationBindingPaths,
    stationPaths,
  };
}

/** Stop a new install before it can mutate state already owned by another managed runtime. */
export function assertNoManagedDistributedVllmRuntimeReceipts(
  options: { readonly homeDir?: string } = {},
): void {
  const receipts = findManagedDistributedVllmRuntimeReceipts(options);
  const paths = [
    ...(receipts.sparkPath ? [receipts.sparkPath] : []),
    ...(receipts.sparkBindingPath ? [receipts.sparkBindingPath] : []),
    ...receipts.sparkDiscoveryBindingPaths,
    ...receipts.stationPaths,
    ...receipts.stationBindingPaths,
  ];
  if (paths.length === 0) return;
  throw new Error(
    `Managed vLLM runtime state already exists at ${paths.join(
      ", ",
    )}; recover it through Local vLLM or uninstall it before starting a new managed install.`,
  );
}
