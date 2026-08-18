// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type {
  DualStationSshBinding as ManagedVllmSshBinding,
  QualifiedStationSshIdentity as QualifiedManagedVllmSshIdentity,
  WriteDualStationSshBindingOptions as WriteManagedVllmSshBindingOptions,
} from "../vllm-station-ssh-binding.js";
export { strictVllmSshTransportArgs as strictManagedVllmSshTransportArgs } from "./vllm-ssh-transport-policy.js";
/**
 * Cardinality-neutral names for the pinned SSH transport shared by managed
 * vLLM clusters. The legacy Station implementation remains the compatibility
 * provider until that existing path is migrated to the serving catalog.
 */
export {
  assertDualStationSshBindingFiles as assertManagedVllmSshBindingFiles,
  clearDualStationSshBinding as clearManagedVllmSshBinding,
  copyDualStationSshBinding as copyManagedVllmSshBinding,
  dualStationDockerSshUri as managedVllmDockerSshUri,
  dualStationPinnedSshArgs as managedVllmPinnedSshArgs,
  dualStationSshBindingDirectory as managedVllmSshBindingDirectory,
  encodeDualStationSshBindingHandoff as encodeManagedVllmSshBindingHandoff,
  loadDualStationSshBinding as loadManagedVllmSshBinding,
  loadDualStationSshBindingForStatePath as loadManagedVllmSshBindingForStatePath,
  loadDualStationSshBindingHandoff as loadManagedVllmSshBindingHandoff,
  stationKnownHostsDigest as managedVllmKnownHostsDigest,
  writeDualStationSshBinding as writeManagedVllmSshBinding,
} from "../vllm-station-ssh-binding.js";
