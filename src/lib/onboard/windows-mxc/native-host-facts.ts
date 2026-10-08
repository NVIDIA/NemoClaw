// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import type { WindowsMxcHostFacts } from "./host-qualification";

export interface WindowsMxcNativeHostRuntime {
  readonly platform: NodeJS.Platform;
  readonly machine: () => string;
  readonly nativeArchitectureOverride?: () => string | undefined;
  readonly release: () => string;
}

const DEFAULT_RUNTIME: WindowsMxcNativeHostRuntime = {
  platform: process.platform,
  machine: () => os.machine(),
  nativeArchitectureOverride: () => {
    const wow64Architecture = process.env.PROCESSOR_ARCHITEW6432?.trim();
    if (wow64Architecture) return wow64Architecture;
    const processorIdentifier = process.env.PROCESSOR_IDENTIFIER?.trim().toLowerCase() ?? "";
    if (/\b(?:arm64|armv8|aarch64)\b/u.test(processorIdentifier)) return "arm64";
    return undefined;
  },
  release: () => os.release(),
};

function normalizeNativeArchitecture(machine: string): string {
  switch (machine.trim().toLowerCase()) {
    case "amd64":
    case "x86_64":
      return "x64";
    case "aarch64":
      return "arm64";
    default:
      return machine.trim().toLowerCase();
  }
}

/** Collect native host facts without using WSL or the Node.js binary architecture. */
export function observeWindowsMxcNativeHostFacts(
  runtime: WindowsMxcNativeHostRuntime = DEFAULT_RUNTIME,
): WindowsMxcHostFacts {
  return Object.freeze({
    platform: runtime.platform,
    nativeArchitecture: normalizeNativeArchitecture(
      runtime.nativeArchitectureOverride?.()?.trim() || runtime.machine(),
    ),
    release: runtime.release(),
  });
}
