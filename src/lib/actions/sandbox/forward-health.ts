// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { probeLocalForwardListener } from "../../adapters/openshell/local-forward-listener";

export type SandboxForwardHealth = boolean;

/**
 * Synchronous reachability check for a local port. Reachability is transport
 * evidence only. Launch refuses a port that was reachable before the detached
 * OpenShell child started.
 */
export function isLocalForwardReachable(port: number, timeoutMs?: number): boolean {
  return probeLocalForwardListener(port, timeoutMs);
}
