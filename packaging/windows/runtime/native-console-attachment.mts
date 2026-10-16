// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

/** Attach only to the session's existing sandbox through its authenticated CLI environment. */
export function openNativeConsoleAttachment(
  executable: string,
  sandboxName: string,
  environment: NodeJS.ProcessEnv,
) {
  const child = spawn(executable, ["sandbox", "connect", sandboxName], {
    env: environment,
    stdio: "inherit",
    windowsHide: false,
  });
  let closed = false;
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", () => {
      reject(new Error("The authenticated native terminal client could not start."));
    });
    child.once("close", (code, signal) => {
      closed = true;
      if (signal !== null || !Number.isInteger(code)) {
        reject(
          new Error("The authenticated native terminal client stopped without an exit status."),
        );
      } else resolve(code!);
    });
  });
  // Startup and cleanup can fail before the caller begins awaiting this client.
  void exited.catch(() => {});
  return {
    exited,
    async waitForExit(timeout = 5000): Promise<number> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("The authenticated native terminal client did not finish.")),
              timeout,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async dispose(): Promise<void> {
      // The caller first removes the sandbox and stops its private gateway,
      // which closes the relay and lets OpenSSH drain even with stdin retained.
      // Do not kill only the CLI and mistake its exit for descendant cleanup.
      try {
        await this.waitForExit();
      } catch (error) {
        if (!closed) {
          // The native runtime guardian owns the complete host process job.
          // Let failure unwind to that owner instead of retaining this event loop.
          child.unref();
          throw error;
        }
      }
    },
  };
}

/** A detached terminal is not evidence that the contained agent finished. */
export async function reconcileNativeConsoleExit(
  clientExit: Promise<number>,
  agentExit: Promise<number>,
  timeout = 10_000,
): Promise<number> {
  const first = await Promise.race([
    clientExit.then((code) => ({ source: "client", code })),
    agentExit.then((code) => ({ source: "agent", code })),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const otherCode = await Promise.race([
      first.source === "client" ? agentExit : clientExit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                first.source === "client"
                  ? "The terminal disconnected before the contained agent finished."
                  : "The native terminal did not finish after the contained agent exited.",
              ),
            ),
          timeout,
        );
      }),
    ]);
    if (first.code !== otherCode)
      throw new Error("The terminal and contained agent reported different exit statuses.");
    return otherCode;
  } finally {
    clearTimeout(timer);
  }
}
