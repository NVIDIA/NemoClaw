// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncReturns } from "node:child_process";
import type { MessagingOpenShellRunner } from "../../src/lib/messaging/applier/types";

/** Supply sandbox file I/O while the real messaging compiler and applier run. */
export function messagingSandboxFiles(files: Record<string, string>) {
  return (
    args: Parameters<MessagingOpenShellRunner>[0],
    options?: Parameters<MessagingOpenShellRunner>[1],
  ): SpawnSyncReturns<string> => {
    const target = String(args.at(-1));
    let status = 0;
    let stdout = "";
    if (args.includes('test ! -e "$1"')) {
      status = files[target] === undefined ? 0 : 1;
    } else if (args.includes("cat") && options?.input === undefined) {
      status = files[target] === undefined ? 1 : 0;
      stdout = files[target] ?? "";
    } else if (options?.input !== undefined) {
      files[target] = options.input;
    } else {
      throw new Error(`Unexpected sandbox file operation: ${args.join(" ")}`);
    }
    return { status, stdout, stderr: "", signal: null, pid: 1, output: [null, stdout, ""] };
  };
}
