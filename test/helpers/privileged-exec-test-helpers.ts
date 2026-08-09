// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";

export async function waitForChildExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

export function createOrdinaryExecReleaseSleeper(
  releasePath: string,
  waitBuffer: Int32Array,
): {
  readonly sleep: (milliseconds: number) => void;
  readonly wasReleased: () => boolean;
} {
  let released = false;
  return {
    sleep: (milliseconds) => {
      if (!released) {
        released = true;
        fs.writeFileSync(releasePath, "release");
      }
      Atomics.wait(waitBuffer, 0, 0, Math.min(milliseconds, 50));
    },
    wasReleased: () => released,
  };
}

export async function releaseAndStopChild(child: ChildProcess, releasePath: string): Promise<void> {
  if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, "release");
  if (child.exitCode === null) child.kill("SIGKILL");
  await waitForChildExit(child).catch(() => null);
}

export function createPersistedLifecycleStoreOrThrow(
  stateMutationGate: { readonly storeError?: Error } | undefined,
): Record<string, never> {
  if (stateMutationGate?.storeError) throw stateMutationGate.storeError;
  return {};
}
