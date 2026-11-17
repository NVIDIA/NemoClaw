// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";
import vm from "node:vm";

export function policyFileStat(overrides: Record<string, unknown> = {}): fs.BigIntStats {
  return {
    dev: 1n,
    ino: 2n,
    mode: 0o100600n,
    nlink: 1n,
    uid: 1000n,
    gid: 1000n,
    size: 10n,
    mtimeNs: 1n,
    ctimeNs: 1n,
    isFile: () => true,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    ...overrides,
  } as unknown as fs.BigIntStats;
}

/** Stateful permission-boundary double; assertions stay in the owning test. */
export function hermesPolicyCleanupFilesystem() {
  const state = {
    file: policyFileStat(),
    parent: policyFileStat({ mode: 0o40700n, isDirectory: () => true, isFile: () => false }),
    removed: false,
    childStatus: 0,
    childError: undefined as Error | undefined,
    verifyError: undefined as Error | undefined,
  };
  function child(args: string[]) {
    const effects = { deleted: false };
    return {
      effects,
      run: () =>
        vm.runInNewContext(args[2], {
          require: () => ({
            lstatSync: (target: string) =>
              target === "/sandbox/.hermes" ? state.parent : state.file,
            unlinkSync: (target: string) => {
              effects.deleted = target === args.at(-3);
            },
          }),
          process: {
            argv: ["node", ...args.slice(-3)],
            getuid: () => 1000,
            getgid: () => 1000,
            exit: () => {
              throw new Error("child refused changed source");
            },
          },
        }),
    };
  }
  return {
    state,
    lstat(target: fs.PathLike, options?: { bigint?: boolean }) {
      if (options?.bigint) return target === "/sandbox/.hermes" ? state.parent : state.file;
      if (target === "/usr/bin/id" || target === process.execPath) {
        return { isFile: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o100755 };
      }
      if (state.verifyError) throw state.verifyError;
      if (state.removed) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return state.file;
    },
    spawn(command: string, args: string[]) {
      if (command === "/usr/bin/id") return { status: 0, stdout: "1000\n" };
      if (state.childStatus === 0 && !state.childError) {
        const execution = child(args);
        execution.run();
        state.removed = execution.effects.deleted;
      }
      return { status: state.childStatus, error: state.childError, stdout: "", stderr: "" };
    },
    child,
  };
}
