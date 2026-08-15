// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MANAGED_CLUSTER_ID_PATTERN } from "./managed-cluster-identifiers.js";

export const MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE = "managed-cluster-vllm-runtime.json";
export const MANAGED_CLUSTER_MANAGED_SERVING_STATE_FILE = "managed-cluster-managed-serving.json";

const RUNTIME_BINDING_PREFIX = `${MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE}.rank-`;
const DISCOVERY_BINDING_PREFIX = `${MANAGED_CLUSTER_MANAGED_SERVING_STATE_FILE}.`;
const BINDING_SUFFIX = ".ssh-binding";

export function isManagedClusterRuntimeBindingStateEntry(entry: string): boolean {
  if (!entry.startsWith(RUNTIME_BINDING_PREFIX) || !entry.endsWith(BINDING_SUFFIX)) return false;
  const rank = entry.slice(RUNTIME_BINDING_PREFIX.length, -BINDING_SUFFIX.length);
  // Rank 0 is local; only remote SSH execution roles own copied binding directories.
  return /^(?:[1-9]\d{0,3})$/u.test(rank) && Number(rank) <= 1_023;
}

export function isManagedClusterDiscoveryBindingStateEntry(entry: string): boolean {
  if (!entry.startsWith(DISCOVERY_BINDING_PREFIX) || !entry.endsWith(BINDING_SUFFIX)) return false;
  const nodeId = entry.slice(DISCOVERY_BINDING_PREFIX.length, -BINDING_SUFFIX.length);
  return MANAGED_CLUSTER_ID_PATTERN.test(nodeId);
}
