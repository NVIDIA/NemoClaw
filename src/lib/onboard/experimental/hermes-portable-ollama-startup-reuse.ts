// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  HermesPortableOllamaRecoveryInput,
  HermesPortableOllamaPreparedProbeDependency,
  inspectHermesPortableOllamaReadinessRuntime,
} from "./hermes-portable-ollama-inference";
import type { qualifyHermesPortableOperatingAuthority } from "./hermes-portable-operating-authority";
import type {
  HermesPortableConfiguredReceipt,
  readHermesPortableLifecycleReceipt,
} from "./hermes-portable-receipt";
import {
  currentHermesPortableStartupOperation,
  hermesPortableStartupReuseGateEnabled,
} from "./hermes-portable-startup-operation";
import { defaultPortableDemoStateDir } from "./portable-runtime-receipt-readiness";

interface StartupReuseDeps {
  readonly measureEntry?: <T>(
    stage: "operatingAuthority" | "exactRuntimeInspection",
    operation: () => T,
  ) => T;
  readonly measureAsync?: <T>(
    stage: "route" | "dependency",
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly readReceipt: typeof readHermesPortableLifecycleReceipt;
  readonly qualifyOperatingAuthority: typeof qualifyHermesPortableOperatingAuthority;
  readonly inspectReadinessRuntime: typeof inspectHermesPortableOllamaReadinessRuntime;
}

/** Prove a healthy published runtime before opening a mutating recovery transaction. */
export async function tryReuseHermesPortableOllamaStartup(
  input: HermesPortableOllamaRecoveryInput,
  deps: StartupReuseDeps,
): Promise<boolean> {
  const env = input.env ?? process.env;
  const stateDir = input.stateDir ?? defaultPortableDemoStateDir(env);
  const scope = currentHermesPortableStartupOperation(input.sandboxName);
  if (
    input.intent !== "connect-probe-only" ||
    env.NEMOCLAW_EXPERIMENTAL_PROFILE !== "portable" ||
    !hermesPortableStartupReuseGateEnabled(env) ||
    !scope ||
    scope.stateDir !== path.join(stateDir, "state")
  ) {
    return false;
  }
  const measureEntry =
    deps.measureEntry ?? (<T>(_stage: string, operation: () => T) => operation());
  const measureAsync =
    deps.measureAsync ?? (<T>(_stage: string, operation: () => Promise<T>) => operation());
  const currentScope = () => currentHermesPortableStartupOperation(input.sandboxName) === scope;
  input.assertCallerCurrent?.();
  const snapshot = deps.readReceipt(input.sandboxName, stateDir);
  if (!snapshot || snapshot.receipt.phase !== "active" || !snapshot.successor) return false;
  const expectedSnapshot = structuredClone(snapshot);
  const expectedEnv = { ...env };
  const expectedEntry = structuredClone(input.entry);
  const operating = measureEntry("operatingAuthority", () =>
    deps.qualifyOperatingAuthority(
      snapshot as typeof snapshot & { readonly receipt: HermesPortableConfiguredReceipt },
      { env },
    ),
  );
  const assertCurrent = () => {
    input.assertCallerCurrent?.();
    operating.assertCurrent();
    if (
      !isDeepStrictEqual({ ...env }, expectedEnv) ||
      !isDeepStrictEqual({ ...(input.env ?? process.env) }, expectedEnv) ||
      !isDeepStrictEqual(
        structuredClone(deps.readReceipt(input.sandboxName, stateDir)),
        expectedSnapshot,
      ) ||
      !isDeepStrictEqual(input.entry, expectedEntry) ||
      !isDeepStrictEqual(input.readRegistry(input.sandboxName), expectedEntry)
    ) {
      throw new Error("Hermes Portable inference startup authority changed");
    }
    input.assertCallerTransactionCurrent?.();
  };
  const inspect = () =>
    measureEntry("exactRuntimeInspection", () =>
      deps.inspectReadinessRuntime({
        intent: "connect-probe-only",
        sandboxName: input.sandboxName,
        entry: input.entry,
        operatingReceipt: operating.receipt,
        readRegistry: input.readRegistry,
        assertCallerCurrent: assertCurrent,
        env,
        stateDir,
      }),
    );
  assertCurrent();
  const initial = inspect();
  if (initial.kind !== "running-current" || !currentScope()) return false;
  let verified;
  try {
    verified = await measureAsync("route", input.verifyRoute);
  } catch {
    // A missing route can require the existing rollback-safe recovery path.
    assertCurrent();
    return false;
  }
  assertCurrent();
  initial.assertCurrent();
  if (!isDeepStrictEqual(verified, expectedEntry)) {
    throw new Error("Hermes Portable inference startup route authority changed");
  }
  if (!currentScope()) return false;
  let dependency: HermesPortableOllamaPreparedProbeDependency | null = null;
  try {
    dependency = await measureAsync(
      "dependency",
      async () => (await input.prepareProbeDependency?.()) ?? null,
    );
    assertCurrent();
    // Re-inspect after the async route/dependency boundaries: retained file proof
    // alone cannot establish that the same container is still running.
    const completed = initial.reinspect
      ? measureEntry("exactRuntimeInspection", initial.reinspect)
      : inspect();
    completed.assertCurrent();
    if (completed.kind !== "running-current" || !currentScope()) {
      const rollback = dependency;
      dependency = null;
      await rollback?.rollback();
      return false;
    }
    dependency?.release();
    return true;
  } catch (error) {
    await dependency?.rollback();
    throw error;
  }
}
