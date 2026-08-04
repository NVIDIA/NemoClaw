// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Renders the manual gateway-removal command block shared by every onboard
 * failure hint.
 *
 * OpenShell dropped the `gateway destroy` lifecycle verb in 0.0.44; current
 * builds answer it with `error: unrecognized subcommand 'destroy'` (#8139).
 * #6570 fixed the destroy-path hint but left the onboard hints printing the
 * legacy verb behind a prose caveat the reader cannot evaluate, so gate it on
 * the same capability probe the execution paths already use
 * (`gatewayCliSupportsLifecycleCommands`).
 *
 * `supportsLifecycleCommands` defaults to false so an un-probed caller prints
 * only the verb that current OpenShell accepts.
 *
 * Current consumers: gateway-start-failure.ts, gpu-recovery.ts,
 * gateway-gpu-passthrough.ts.
 */
export function gatewayRemovalHintLines(
  gatewayName: string,
  supportsLifecycleCommands = false,
): string[] {
  const lines = [`    openshell gateway remove ${gatewayName}`];
  if (supportsLifecycleCommands) {
    lines.push("    # For OpenShell releases that still expose lifecycle commands:");
    lines.push(`    openshell gateway destroy -g ${gatewayName}`);
  }
  return lines;
}
