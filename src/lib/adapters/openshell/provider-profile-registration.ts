// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  importCliOpenShellProviderProfile,
  type CapturedProviderCommandResult,
  type CliOpenShellProviderProfileResult,
} from "./provider-adapter-cli";

export type EndpointlessProviderProfileRunner = (
  args: string[],
  options: {
    readonly ignoreError: true;
    readonly suppressOutput?: boolean;
    readonly stdio: ["ignore", "pipe", "pipe"];
    readonly timeout: number;
  },
) => {
  readonly status?: number | null;
  readonly output?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly error?: unknown;
};

function capturedResult(
  result: ReturnType<EndpointlessProviderProfileRunner>,
): CapturedProviderCommandResult {
  return {
    status: result.status ?? null,
    output: result.output,
    stdout:
      typeof result.stdout === "string" || Buffer.isBuffer(result.stdout) ? result.stdout : null,
    stderr:
      typeof result.stderr === "string" || Buffer.isBuffer(result.stderr) ? result.stderr : null,
    ...(result.error instanceof Error ? { error: result.error } : {}),
  };
}

/** Normalize a legacy runner and delegate the registration protocol to the CLI adapter owner. */
export function registerCheckedInProviderProfile(input: {
  readonly profilePath: string;
  readonly runOpenshell: EndpointlessProviderProfileRunner;
  readonly readProfileFile?: (profilePath: string) => string;
}): CliOpenShellProviderProfileResult {
  return importCliOpenShellProviderProfile(
    { profilePath: input.profilePath, target: { kind: "selected" } },
    {
      readProfileFile: input.readProfileFile,
      run: (args, options) => capturedResult(input.runOpenshell(args, options)),
    },
  );
}
