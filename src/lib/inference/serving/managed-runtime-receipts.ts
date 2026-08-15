// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listGatewayStateRoots } from "../../state/gateway-registry";
import { managedVllmStateDir } from "../vllm-api-key";
import { DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE } from "../vllm-station-runtime-receipt-path";
import {
  isManagedClusterDiscoveryBindingStateEntry,
  isManagedClusterRuntimeBindingStateEntry,
  MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
} from "./managed-cluster-runtime-receipt-path";

export { MCP_LIFECYCLE_LOCK_DIRNAME } from "../../state/mcp-lifecycle-lock-storage";
export { MANAGED_VLLM_API_KEY_FILE } from "../vllm-api-key";
export { DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE } from "../vllm-station-runtime-receipt-path";
export {
  isManagedClusterDiscoveryBindingStateEntry,
  isManagedClusterRuntimeBindingStateEntry,
  MANAGED_CLUSTER_MANAGED_SERVING_STATE_FILE,
  MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
} from "./managed-cluster-runtime-receipt-path";

export interface ManagedDistributedVllmRuntimeReceipts {
  readonly managedClusterBindingPaths: readonly string[];
  readonly managedClusterDiscoveryBindingPaths: readonly string[];
  readonly managedClusterPath: string | null;
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

function matchingStateEntries(
  stateRoots: readonly { readonly root: string }[],
  predicate: (entry: string) => boolean,
): readonly string[] {
  return stateRoots
    .flatMap(({ root }) => {
      try {
        return fs
          .readdirSync(root)
          .filter(predicate)
          .map((entry) => path.join(root, entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    })
    .sort();
}

/** Locate durable distributed-runtime ownership without parsing or following receipt paths. */
export function findManagedDistributedVllmRuntimeReceipts(
  options: { readonly homeDir?: string } = {},
): ManagedDistributedVllmRuntimeReceipts {
  const homeDir = options.homeDir ?? os.homedir();
  const stateRoots = listGatewayStateRoots(homeDir);
  const managedClusterPath = path.join(
    managedVllmStateDir(homeDir),
    MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
  );
  const stationPaths = stateRoots
    .map(({ root }) => path.join(root, DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE))
    .filter(pathExistsNoFollow);
  const managedClusterBindingPaths = matchingStateEntries(
    stateRoots,
    isManagedClusterRuntimeBindingStateEntry,
  );
  const managedClusterDiscoveryBindingPaths = matchingStateEntries(
    stateRoots,
    isManagedClusterDiscoveryBindingStateEntry,
  );
  const stationBindingPaths = stateRoots
    .map(({ root }) => `${path.join(root, DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE)}.ssh-binding`)
    .filter(pathExistsNoFollow);
  return {
    managedClusterBindingPaths,
    managedClusterDiscoveryBindingPaths,
    managedClusterPath: pathExistsNoFollow(managedClusterPath) ? managedClusterPath : null,
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
    ...(receipts.managedClusterPath ? [receipts.managedClusterPath] : []),
    ...receipts.managedClusterBindingPaths,
    ...receipts.managedClusterDiscoveryBindingPaths,
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
