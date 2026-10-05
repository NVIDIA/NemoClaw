// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellForwardIdentity } from "./forward";

/** Build the direct ForwardTcp command without a shell. */
export function buildCliOpenShellForwardServiceArgs(forward: OpenShellForwardIdentity): string[] {
  return [
    "--gateway",
    forward.gatewayName,
    "--gateway-endpoint",
    forward.gatewayEndpoint,
    "--workspace",
    forward.workspace,
    "forward",
    "service",
    forward.sandboxName,
    "--target-port",
    String(forward.port),
    "--target-host",
    "127.0.0.1",
    "--local",
    `${forward.localHost}:${String(forward.port)}`,
  ];
}
