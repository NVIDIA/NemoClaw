// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { deleteCredentialByBinding, readCredentialByBinding } from "./native-security.mts";

export type CredentialChange = { provider: string; binding: string; value: string };

async function writeCredential(launcher: string, change: CredentialChange): Promise<void> {
  if (!change.value) return deleteCredentialByBinding(launcher, change.provider, change.binding);
  const bytes = Buffer.from(change.value, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        launcher,
        ["--credential-write", change.provider, "--binding", change.binding],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let outputBytes = 0;
      let failed = false;
      const timer = setTimeout(() => {
        failed = true;
        child.kill();
      }, 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
      });
      child.stderr.resume();
      child.stdin.on("error", () => {
        failed = true;
        child.kill();
      });
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Windows could not update the selected stored key."));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0 || outputBytes !== 0)
          reject(new Error("Windows could not update the selected stored key."));
        else resolve();
      });
      child.stdin.end(bytes);
    });
  } finally {
    bytes.fill(0);
  }
}

export const nativeConfigurationCredentialStore = {
  read: (launcher: string, change: CredentialChange) =>
    readCredentialByBinding(launcher, change.provider, change.binding, true),
  write: writeCredential,
};

// The caller owns the per-agent state lease for the entire transaction, including rollback.
// Nothing here persists a plaintext snapshot or sends a secret in process arguments.
export async function withNativeCredentialTransaction<T>(
  launcher: string,
  changes: CredentialChange[],
  assertHeld: () => void,
  commit: () => Promise<T>,
  store = nativeConfigurationCredentialStore,
): Promise<T> {
  const previous: CredentialChange[] = [];
  const attempted: CredentialChange[] = [];
  try {
    for (const change of changes) {
      assertHeld();
      previous.push({ ...change, value: await store.read(launcher, change) });
    }
    for (const [index, change] of changes.entries()) {
      assertHeld();
      // Include a failed write: the helper can mutate the vault before its exit is observed.
      attempted.push(previous[index]);
      await store.write(launcher, change);
    }
    assertHeld();
    return await commit();
  } catch {
    let rollbackFailed = false;
    for (const change of attempted.reverse()) {
      try {
        assertHeld();
        await store.write(launcher, change);
      } catch {
        rollbackFailed = true;
      }
    }
    throw new Error(
      rollbackFailed
        ? "Native setup failed and credential recovery is incomplete. Reopen Setup before launching."
        : "Native setup failed; previous credentials were preserved.",
    );
  } finally {
    for (const change of previous) change.value = "";
  }
}
