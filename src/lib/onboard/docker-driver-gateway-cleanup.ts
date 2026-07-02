// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const CLEANUP_FAILURE_WARNING =
  "  ⚠ Gateway cleanup after sandbox-bridge failure failed: Docker-driver gateway cleanup did not stop the process.";

export function warnIfCleanupFailed(
  stopDockerDriverGatewayProcess: () => boolean,
  warn: (message: string) => void = console.warn,
): void {
  if (!stopDockerDriverGatewayProcess()) warn(CLEANUP_FAILURE_WARNING);
}
