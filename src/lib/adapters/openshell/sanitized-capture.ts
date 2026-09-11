// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildOpenShellSubprocessEnv, resolveOpenshellBinaryOrNull } from "./resolve-shared";
import * as openshellRuntime from "./runtime";
import type { CapturedOpenShellCommandResult } from "./sandbox-observer-cli";

type SanitizedCaptureOptions = Readonly<{
  ignoreError: true;
  includeStderr: true;
  includeStreams: true;
  maxBuffer: number;
  timeout: number;
  env?: Record<string, string>;
  replaceEnv?: true;
}>;

type SanitizedAsyncCaptureOptions = Omit<SanitizedCaptureOptions, "maxBuffer"> &
  Readonly<{ outputLimitBytes: number }>;

/** Capture a bounded OpenShell read with a credential-minimizing environment. */
function resolveCapture(args: string[]) {
  const env = buildOpenShellSubprocessEnv();
  for (const name of ["XDG_CONFIG_HOME", "OPENSHELL_WORKSPACE"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const gatewayIndex = args.indexOf("-g");
  if (gatewayIndex >= 0 && args[gatewayIndex + 1]) env.OPENSHELL_GATEWAY = args[gatewayIndex + 1];

  const openshell = resolveOpenshellBinaryOrNull();
  if (!openshell) {
    return null;
  }
  if (!path.isAbsolute(openshell)) throw new Error("OpenShell executable must be absolute");
  return { openshell, env };
}

function missingBinary(): CapturedOpenShellCommandResult {
  return {
    status: null,
    output: "",
    error: Object.assign(new Error("OpenShell binary not found"), { code: "ENOENT" }),
  };
}

export function captureSanitizedResolvedOpenshell(
  args: string[],
  opts: SanitizedCaptureOptions,
): CapturedOpenShellCommandResult {
  const resolved = resolveCapture(args);
  if (!resolved) return missingBinary();
  return openshellRuntime.captureOpenshell(args, {
    openshellBinary: resolved.openshell,
    env: resolved.env,
    replaceEnv: true,
    ...opts,
  });
}

export async function captureSanitizedResolvedOpenshellAsync(
  args: string[],
  opts: SanitizedAsyncCaptureOptions,
): Promise<CapturedOpenShellCommandResult> {
  const resolved = resolveCapture(args);
  if (!resolved) return missingBinary();
  return openshellRuntime.captureResolvedOpenshellAsync(args, {
    ...opts,
    openshellBinary: resolved.openshell,
    env: opts.env ?? resolved.env,
    replaceEnv: true,
  });
}
