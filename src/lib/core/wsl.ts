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
  // Explicit override — lets tests pin behavior regardless of the host kernel.
  // Useful because the WSL detection below consults `os.release()`, which
  // returns a "microsoft"-tagged string on WSL2 hosts even when env vars are
  // unset. Without this override, any test calling functions that consult
  // `isWsl()` becomes non-deterministic on WSL2 dev machines.
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
