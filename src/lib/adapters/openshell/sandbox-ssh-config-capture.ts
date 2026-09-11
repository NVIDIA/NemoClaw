// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type SandboxSshConfigCaptureResult = Readonly<{
  error?: Error;
  output: string;
  status: number | null;
}>;

type CaptureSandboxCommand = (
  args: string[],
  options: Readonly<{ includeStderr: boolean }>,
) => SandboxSshConfigCaptureResult;

function gatewayScopedArgs(args: string[], gatewayName?: string): string[] {
  if (!gatewayName) return args;
  return [...args.slice(0, 2), "-g", gatewayName, ...args.slice(2)];
}

/** Capture one sandbox's SSH configuration after confirming it exists on the same gateway. */
export function captureSandboxSshConfig(
  sandboxName: string,
  gatewayName: string | undefined,
  capture: CaptureSandboxCommand,
): SandboxSshConfigCaptureResult {
  const sandboxGet = capture(gatewayScopedArgs(["sandbox", "get", sandboxName], gatewayName), {
    includeStderr: true,
  });
  if (sandboxGet.status !== 0 || sandboxGet.error) {
    const output = sandboxGet.output || `failed to query sandbox '${sandboxName}'`;
    const sandboxMissing = /\bnot[- ]?found\b/iu.test(output);
    return {
      ...sandboxGet,
      output: sandboxMissing ? `sandbox '${sandboxName}' not found` : output,
    };
  }
  return capture(gatewayScopedArgs(["sandbox", "ssh-config", sandboxName], gatewayName), {
    includeStderr: false,
  });
}
