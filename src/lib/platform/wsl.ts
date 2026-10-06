// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

export interface WslDetectionOptions {
  isWsl?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
  procVersion?: string;
}

export function isWsl(opts: WslDetectionOptions = {}): boolean {
  // The explicit override keeps callers deterministic on WSL development hosts.
  if (typeof opts.isWsl === "boolean") return opts.isWsl;

  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return false;

  const env = opts.env ?? process.env;
  const release = opts.release ?? os.release();
  const procVersion = opts.procVersion ?? "";

  return (
    Boolean(env.WSL_DISTRO_NAME) ||
    Boolean(env.WSL_INTEROP) ||
    /microsoft/i.test(release) ||
    /microsoft/i.test(procVersion)
  );
}
