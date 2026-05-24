// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DebugOptions } from "./debug";

export type ExplicitSandboxValidation = { ok: true } | { ok: false; message: string };

export interface RunDebugCommandDeps {
  getDefaultSandbox: () => string | undefined;
  validateExplicitSandbox?: (name: string) => ExplicitSandboxValidation;
  runDebug: (options: DebugOptions) => void;
  fail?: (message: string, exitCode?: number) => never;
}

function defaultFail(message: string, exitCode = 1): never {
  console.error(message);
  process.exit(exitCode);
}

export function runDebugCommandWithOptions(options: DebugOptions, deps: RunDebugCommandDeps): void {
  const opts = { ...options };
  if (opts.sandboxName) {
    const validate = deps.validateExplicitSandbox;
    if (validate) {
      const result = validate(opts.sandboxName);
      if (!result.ok) {
        const fail = deps.fail ?? defaultFail;
        fail(result.message, 1);
        return;
      }
    }
  } else {
    opts.sandboxName = deps.getDefaultSandbox();
  }
  deps.runDebug(opts);
}
