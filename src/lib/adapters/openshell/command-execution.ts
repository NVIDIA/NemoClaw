// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Low-level OpenShell CLI/runtime primitives shared by the runtime facade and
 * typed CLI adapters. Keep higher-level adapter behavior out of this module.
 */
export {
  captureOpenshellCommand,
  captureOpenshellCommandAsync,
  captureOpenshellCommandAsyncResult,
  captureSandboxSshConfigCommand,
  classifyManagedGatewayEndpointBinding,
  getInstalledOpenshellVersion,
  runOpenshellCommand,
} from "./client";
export { OPENSHELL_OPERATION_TIMEOUT_MS, OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";
