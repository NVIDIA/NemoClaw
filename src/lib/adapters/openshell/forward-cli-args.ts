// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellForwardIdentity } from "./forward";

/** Compare argv spelling after the caller has verified the process's hosting executable. */
export function matchesCliOpenShellForwardCommand(
  command: string,
  executable: string,
  args: readonly string[],
): boolean {
  const suffix = ` ${args.join(" ")}`;
  if (!command.endsWith(suffix)) return false;
  const actualExecutable = command.slice(0, -suffix.length);
  if (actualExecutable === executable) return true;
  // Collapse only internal POSIX separators. Preserve dot segments, symlink
  // spellings, and the implementation-defined double-root namespace.
  if (
    !actualExecutable.startsWith("/") ||
    actualExecutable.startsWith("//") ||
    !executable.startsWith("/") ||
    executable.startsWith("//")
  )
    return false;
  return actualExecutable.replace(/\/{2,}/gu, "/") === executable.replace(/\/{2,}/gu, "/");
}

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
