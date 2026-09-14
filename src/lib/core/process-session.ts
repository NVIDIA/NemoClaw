// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type ProcessSessionChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once: {
    (event: "error", listener: (error: Error) => void): unknown;
    (
      event: "close",
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): unknown;
  };
};
export type ProcessSessionSignals = {
  add(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
  remove(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
};
export type ProcessSessionResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  releaseSignals?: () => void;
};
const defaultSignals: ProcessSessionSignals = {
  add: (signal, listener) => process.on(signal, listener),
  remove: (signal, listener) => process.off(signal, listener),
};

/** Keep host termination handlers installed until the caller finishes cleanup. */
export async function superviseProcessSession(
  spawnChild: () => ProcessSessionChild,
  signalSource: ProcessSessionSignals = defaultSignals,
  options: { forwardSigint?: boolean } = {},
): Promise<ProcessSessionResult> {
  let child: ProcessSessionChild;
  try {
    child = spawnChild();
  } catch (error) {
    return { status: null, error: error instanceof Error ? error : new Error(String(error)) };
  }

  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    const forwardTerm = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    // Terminal Ctrl+C already reaches the foreground process group. Only
    // headless capture opts into forwarding a signal sent to the parent alone.
    const holdInt = () => {
      if (options.forwardSigint && child.exitCode === null && child.signalCode === null)
        child.kill("SIGINT");
    };
    signalSource.add("SIGTERM", forwardTerm);
    signalSource.add("SIGINT", holdInt);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      resolve({
        status,
        signal,
        ...(spawnError ? { error: spawnError } : {}),
        releaseSignals: () => {
          signalSource.remove("SIGTERM", forwardTerm);
          signalSource.remove("SIGINT", holdInt);
        },
      });
    });
  });
}
