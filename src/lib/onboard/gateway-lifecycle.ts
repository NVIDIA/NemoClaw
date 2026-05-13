// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type CaptureGatewayHelp = (
  args: string[],
  opts: { ignoreError: true; suppressOutput: true },
) => string;

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;

let gatewayLifecycleCommandsSupported: boolean | null = null;

export function gatewayCliSupportsLifecycleCommands(captureGatewayHelp: CaptureGatewayHelp): boolean {
  if (gatewayLifecycleCommandsSupported !== null) {
    return gatewayLifecycleCommandsSupported;
  }

  const help = captureGatewayHelp(["gateway", "--help"], {
    ignoreError: true,
    suppressOutput: true,
  });
  const normalized = String(help || "").replace(ANSI_RE, "");
  gatewayLifecycleCommandsSupported =
    normalized.trim().length > 0 &&
    /\bstart\b/.test(normalized) &&
    /\bdestroy\b/.test(normalized);
  return gatewayLifecycleCommandsSupported;
}
