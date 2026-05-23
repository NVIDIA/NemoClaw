// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DebugOptions } from "./debug";

export interface RunDebugCommandDeps {
  getDefaultSandbox: () => string | undefined;
  runDebug: (options: DebugOptions) => void;
}

export function runDebugCommandWithOptions(options: DebugOptions, deps: RunDebugCommandDeps): void {
  const opts = { ...options };
  if (!opts.sandboxName) {
    opts.sandboxName = deps.getDefaultSandbox();
  }
  deps.runDebug(opts);
}
