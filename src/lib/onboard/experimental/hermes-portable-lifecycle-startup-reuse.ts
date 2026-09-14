// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { HermesPortableLifecycleDeps } from "./hermes-portable-lifecycle";
import type { PortableDemoLifecycleContext } from "./portable-demo-lifecycle";
import { defaultPortableDemoStateDir } from "./portable-runtime-receipt-readiness";
import {
  currentHermesPortableStartupOperation,
  type HermesPortableStartupOperation,
} from "./hermes-portable-startup-operation";

interface RetainedLifecycle {
  readonly context: PortableDemoLifecycleContext;
  readonly env: NodeJS.ProcessEnv;
  readonly entry: unknown;
  readonly deps: HermesPortableLifecycleDeps;
  readonly verify: () => boolean;
}

const completed = new WeakMap<HermesPortableStartupOperation, RetainedLifecycle>();

function currentScope(sandboxName: string, deps: HermesPortableLifecycleDeps) {
  const env = deps.env ?? process.env;
  const scope = currentHermesPortableStartupOperation(sandboxName);
  return env.NEMOCLAW_EXPERIMENTAL_PROFILE === "portable" &&
    env.NEMOCLAW_EXPERIMENTAL_PORTABLE_STARTUP_REUSE === "1" &&
    scope?.stateDir === path.join(deps.stateDir ?? defaultPortableDemoStateDir(env), "state") &&
    deps.startupTimeoutMs === undefined
    ? scope
    : undefined;
}

/** Keep a successful startup proof inside its original lifecycle operation. */
export function retainHermesPortableLifecycleStartup(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: HermesPortableLifecycleDeps,
  verify: () => boolean,
): void {
  const scope = currentScope(sandboxName, deps);
  if (!scope) return;
  completed.set(scope, {
    context: structuredClone(context),
    env: { ...(deps.env ?? process.env) },
    entry: structuredClone(deps.readRegistry?.(sandboxName)),
    deps: { ...deps },
    verify,
  });
}

/** A later probe must still prove live identity, policy, container and authenticated health. */
export function tryReuseHermesPortableLifecycleStartup(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: HermesPortableLifecycleDeps,
): boolean {
  const scope = currentScope(sandboxName, deps);
  const retained = scope && completed.get(scope);
  if (!scope || !retained) return false;
  // Consume before verification: failures and incomplete observations cannot leave reusable proof.
  completed.delete(scope);
  if (
    !isDeepStrictEqual(context, retained.context) ||
    !isDeepStrictEqual({ ...(deps.env ?? process.env) }, retained.env) ||
    !isDeepStrictEqual({ ...(retained.deps.env ?? process.env) }, retained.env) ||
    deps.container !== retained.deps.container ||
    deps.operatingAuthority !== retained.deps.operatingAuthority ||
    deps.podmanAuthorityDeps !== retained.deps.podmanAuthorityDeps
  )
    return false;
  const assertRegistry = () => {
    if (!isDeepStrictEqual(deps.readRegistry?.(sandboxName), retained.entry)) {
      throw new Error("Hermes portable lifecycle registry changed after startup");
    }
  };
  assertRegistry();
  const ready = retained.verify();
  assertRegistry();
  if (!ready || currentScope(sandboxName, deps) !== scope) return false;
  completed.set(scope, retained);
  return true;
}
