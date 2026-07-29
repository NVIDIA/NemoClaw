// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "../../state/registry";
import {
  resolveSandboxLifecycleRuntimeAdapter,
  resolveSandboxLifecycleRuntimeDependencies,
  type SandboxLifecycleRuntimeAdapterRegistry,
  type SandboxLifecycleRuntimeDependencies,
} from "./runtime/lifecycle-runtime";
import { gateDirectDriverLifecycle, type SandboxLifecycleResult } from "./stop";

// Lazy require keeps the heavy connect module out of this module's load path;
// tests inject `deps.probeSandbox`.
function loadConnectProbe(): (sandboxName: string) => Promise<void> {
  const { connectSandbox } = require("./connect") as {
    connectSandbox: (sandboxName: string, options?: { probeOnly?: boolean }) => Promise<void>;
  };
  return (sandboxName) => connectSandbox(sandboxName, { probeOnly: true });
}

export interface SandboxStartDeps extends Partial<SandboxLifecycleRuntimeDependencies> {
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  runtimeAdapters?: SandboxLifecycleRuntimeAdapterRegistry;
  /** Gateway/forward health probe; defaults to the `recover` action body. */
  probeSandbox?: (sandboxName: string) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Restart a stopped sandbox container and bring its gateway and host
 * forwards back up (#6026). Counterpart to `stopSandbox`.
 *
 * The selected compute-runtime adapter restores the exact container (the
 * Docker adapter retains #4423 backup-sibling recovery), then the shared
 * health probe reuses the `recover` action body so forwards and the
 * in-sandbox gateway come back exactly as they would after
 * `nemoclaw <name> recover`.
 */
export async function startSandbox(
  sandboxName: string,
  deps: SandboxStartDeps = {},
): Promise<SandboxLifecycleResult> {
  const log = deps.log ?? console.log;
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const sandbox = getSandbox(sandboxName);

  const gate = gateDirectDriverLifecycle(sandboxName, "start", () => sandbox, deps.runtimeAdapters);
  if (gate) return gate;

  const adapter = resolveSandboxLifecycleRuntimeAdapter(
    sandbox?.openshellDriver,
    deps.runtimeAdapters,
  );
  if (!adapter || !sandbox) {
    return {
      exitCode: 1,
      message: `  No lifecycle runtime adapter is available for sandbox '${sandboxName}'.`,
    };
  }
  const runtimeDeps = resolveSandboxLifecycleRuntimeDependencies(deps);
  const input = {
    environment: deps.environment ?? process.env,
    log,
    sandbox,
    sandboxName,
  };
  const runtimeGate = adapter.preflight("start", input, runtimeDeps);
  if (runtimeGate) return runtimeGate;

  const result = adapter.start(input, runtimeDeps);
  if (result.exitCode !== 0) return result;

  log("  Checking gateway health and host forwards…");
  await (deps.probeSandbox ?? loadConnectProbe())(sandboxName);
  return { exitCode: 0 };
}
