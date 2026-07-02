// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact } from "../../security/redact";

type RebuildSignal = "SIGINT" | "SIGTERM";
type RebuildEvent = "exit" | RebuildSignal;

export type RebuildProcessEvents = {
  once(event: RebuildSignal, listener: () => void): unknown;
  prependOnceListener(event: RebuildEvent, listener: () => void): unknown;
  removeListener(event: RebuildEvent, listener: () => void): unknown;
};

type SignalCleanupOptions = {
  events?: RebuildProcessEvents;
  kill?: (pid: number, signal: RebuildSignal) => unknown;
  pid?: number;
  reportError?: (message: string) => void;
};

function defaultReportError(message: string): void {
  console.error(`  Rebuild interruption recovery warning: ${redact(message)}`);
}

export function installRetainedResourceSignalCleanup(
  cleanup: () => void,
  options: SignalCleanupOptions = {},
): () => void {
  const events = options.events ?? process;
  const kill = options.kill ?? process.kill.bind(process);
  const pid = options.pid ?? process.pid;
  const reportError = options.reportError ?? defaultReportError;
  let armed = true;
  const remove = () => {
    if (!armed) return;
    armed = false;
    events.removeListener("SIGINT", onSigint);
    events.removeListener("SIGTERM", onSigterm);
  };
  const handle = (signal: RebuildSignal) => {
    if (!armed) return;
    remove();
    try {
      cleanup();
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    } finally {
      kill(pid, signal);
    }
  };
  const onSigint = () => handle("SIGINT");
  const onSigterm = () => handle("SIGTERM");
  events.once("SIGINT", onSigint);
  events.once("SIGTERM", onSigterm);
  return remove;
}

export function installPrependedExitAndSignalRecovery(
  recover: () => void,
  options: Pick<SignalCleanupOptions, "events" | "reportError"> = {},
): () => void {
  const events = options.events ?? process;
  const reportError = options.reportError ?? defaultReportError;
  let armed = true;
  const remove = () => {
    if (!armed) return;
    armed = false;
    events.removeListener("exit", onExit);
    events.removeListener("SIGINT", onSignal);
    events.removeListener("SIGTERM", onSignal);
  };
  const runRecovery = () => {
    if (!armed) return;
    remove();
    try {
      recover();
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  };
  const onExit = runRecovery;
  const onSignal = runRecovery;
  events.prependOnceListener("exit", onExit);
  events.prependOnceListener("SIGINT", onSignal);
  events.prependOnceListener("SIGTERM", onSignal);
  return remove;
}
