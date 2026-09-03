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
}>;

/** Capture a bounded OpenShell read with a credential-minimizing environment. */
export function captureSanitizedResolvedOpenshell(
  args: string[],
  opts: SanitizedCaptureOptions,
): CapturedOpenShellCommandResult {
  const env = buildOpenShellSubprocessEnv();
  for (const name of ["XDG_CONFIG_HOME", "OPENSHELL_WORKSPACE"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const gatewayIndex = args.indexOf("-g");
  if (gatewayIndex >= 0 && args[gatewayIndex + 1]) env.OPENSHELL_GATEWAY = args[gatewayIndex + 1];

  const openshell = resolveOpenshellBinaryOrNull();
  if (!openshell) {
    return {
      status: null,
      output: "",
      error: Object.assign(new Error("OpenShell binary not found"), { code: "ENOENT" }),
    };
  }
  if (!path.isAbsolute(openshell)) throw new Error("OpenShell executable must be absolute");
  return openshellRuntime.captureOpenshell(args, {
    openshellBinary: openshell,
    env,
    replaceEnv: true,
    ...opts,
  });
}
