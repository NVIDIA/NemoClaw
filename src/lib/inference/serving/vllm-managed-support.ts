// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export { captureNvidiaSmi, resolveNvidiaSmiCommand } from "../gpu-trust.js";
export { ensureDualStationVllmApiKey, loadDualStationVllmApiKey } from "../vllm-api-key.js";
export {
  buildLocalDualStationDockerEnv,
  buildLocalManagedVllmDockerEnv,
  buildRemoteVllmDockerEnv,
  buildVllmDockerEnv,
} from "../vllm-docker-env.js";
export { resolveVllmInstallModel } from "../vllm-prompt.js";
export {
  type MaterializedHostLocalVllmSelection,
  resolveHostLocalVllmSelection,
} from "./host-local-vllm-selection.js";
export {
  NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV,
  NEMOCLAW_SERVING_PRESET_ENV,
} from "./managed-cluster-discovery.js";
export { tryInstallManagedClusterManagedVllm } from "./managed-cluster-installer.js";
export { recoverInstalledManagedClusterVllmEndpoint } from "./managed-cluster-runtime-receipt.js";
export { runtimeAuthFingerprint } from "./runtime-auth-fingerprint.js";
export {
  persistHostLocalVllmRuntimeReceipt,
  recoverHostLocalManagedVllmEndpoint,
} from "./vllm-host-local-lifecycle.js";
export {
  resolveManagedVllmBridgeHost,
  validateManagedVllmBridgeHost,
} from "./vllm-host-local-network.js";
