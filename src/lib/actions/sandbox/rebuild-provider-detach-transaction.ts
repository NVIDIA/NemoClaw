// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { runOpenshell as runOpenshellType } from "../../adapters/openshell/runtime";
import { R, RD, YW } from "../../cli/terminal-style";
import {
  attachNamedSandboxProviders,
  detachNamedSandboxProviders,
} from "../../onboard/sandbox-provider-cleanup";
import { redact } from "../../security/redact";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";

type AuthoritativeMessagingReuse = NonNullable<
  RebuildRecreateOnboardOpts["authoritativeMessagingReuse"]
>;
type RebuildBail = (message: string, code?: number) => never;
type ExactProviderDetachFailure = { name: string; output: string };

export type SuccessfulExactProviderDetachTransaction = {
  ok: true;
  commit(): void;
  rollback(): ExactProviderDetachFailure[];
};

type ExactProviderDetachTransaction =
  | SuccessfulExactProviderDetachTransaction
  | { ok: false; failure: ExactProviderDetachFailure };

function beginExactProviderDetachTransaction(options: {
  sandboxName: string;
  providerNames: string[];
  relock: () => void;
  runOpenshell: typeof runOpenshellType;
}): ExactProviderDetachTransaction {
  const providerNames = [...new Set(options.providerNames.filter(Boolean))];
  const detachedProviderNames: string[] = [];
  let rollbackArmed = true;
  let onSigint: (() => void) | null = null;
  let onSigterm: (() => void) | null = null;
  const reportFailures = (failures: ExactProviderDetachFailure[]) => {
    for (const failure of failures) {
      console.error(
        `  ${YW}⚠${R} Failed to reattach provider '${failure.name}': ${redact(failure.output)}`,
      );
    }
  };
  const onExit = () => {
    if (!rollbackArmed) return;
    options.relock();
    rollbackArmed = false;
    reportFailures(
      attachNamedSandboxProviders(options.sandboxName, detachedProviderNames, {
        runOpenshell: options.runOpenshell,
      }).failures,
    );
  };
  const removeHandlers = () => {
    process.removeListener("exit", onExit);
    if (onSigint) process.removeListener("SIGINT", onSigint);
    if (onSigterm) process.removeListener("SIGTERM", onSigterm);
  };
  const rollback = (): ExactProviderDetachFailure[] => {
    if (!rollbackArmed) return [];
    rollbackArmed = false;
    removeHandlers();
    const result = attachNamedSandboxProviders(options.sandboxName, detachedProviderNames, {
      runOpenshell: options.runOpenshell,
    });
    reportFailures(result.failures);
    return result.failures;
  };
  const commit = () => {
    rollbackArmed = false;
    removeHandlers();
  };
  const rollbackForSignal = () => {
    options.relock();
    rollback();
  };
  // The rebuild lifecycle lock's exit handler is registered first. Prepend
  // provider rollback so attachments are restored while that lock is held.
  process.prependOnceListener("exit", onExit);
  onSigint = rollbackForSignal;
  onSigterm = rollbackForSignal;
  process.prependOnceListener("SIGINT", onSigint);
  process.prependOnceListener("SIGTERM", onSigterm);

  if (providerNames.length === 0) return { ok: true, commit, rollback };

  let result: ReturnType<typeof detachNamedSandboxProviders>;
  try {
    result = detachNamedSandboxProviders(options.sandboxName, providerNames, {
      runOpenshell: options.runOpenshell,
      onDetached: (providerName) => detachedProviderNames.push(providerName),
    });
  } catch (error) {
    options.relock();
    rollback();
    throw error;
  }
  if (result.failures.length === 0) return { ok: true, commit, rollback };
  options.relock();
  rollback();
  return { ok: false, failure: result.failures[0] };
}

export function beginRebuildProviderDetachOrBail(options: {
  sandboxName: string;
  messagingReuse: AuthoritativeMessagingReuse | undefined;
  hermesToolProvider: string | null;
  staleRecovery: boolean;
  relock: () => void;
  bail: RebuildBail;
  runOpenshell: typeof runOpenshellType;
}): SuccessfulExactProviderDetachTransaction {
  if (!options.messagingReuse) {
    options.relock();
    options.bail("Authoritative messaging provider attachments were not prepared.");
  }
  const transaction = options.staleRecovery
    ? ({ ok: true, commit: () => undefined, rollback: () => [] } as const)
    : beginExactProviderDetachTransaction({
        sandboxName: options.sandboxName,
        providerNames: [
          ...options.messagingReuse.detachProviders,
          ...(options.hermesToolProvider ? [options.hermesToolProvider] : []),
        ],
        relock: options.relock,
        runOpenshell: options.runOpenshell,
      });
  if (transaction.ok) return transaction;

  const { failure } = transaction;
  console.error("");
  console.error(
    `  ${RD}Rebuild preflight failed:${R} could not detach retained provider '${failure.name}'.`,
  );
  console.error(`  ${redact(failure.output)}`);
  console.error("  Sandbox was not deleted; detached providers were restored where possible.");
  options.bail(`Failed to detach retained provider '${failure.name}'.`);
}
