// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  resolveSandboxLifecycleProvider,
  type SandboxLifecycleResult,
} from "./runtime/lifecycle-runtime";

function verifyGateway(sandboxName: string): Promise<void> {
  const { connectSandbox } = require("./connect") as {
    connectSandbox: (name: string, options?: { probeOnly?: boolean }) => Promise<void>;
  };
  return connectSandbox(sandboxName, { probeOnly: true });
}

function restoreProcessState(sandboxName: string): void {
  const { restoreSandboxStartupState } = require("./connect") as typeof import("./connect");
  restoreSandboxStartupState(sandboxName);
}

function restoreLockedStartupAccess(sandboxName: string): void {
  const { restoreLockedStateDirStartupAccess } =
    require("../../shields") as typeof import("../../shields");
  restoreLockedStateDirStartupAccess(sandboxName);
}

export interface SandboxStartupStateDeps {
  agent?: SandboxEntry["agent"];
  restoreLockedStartupAccess?: (sandboxName: string) => void;
  restoreProcessState?: (sandboxName: string) => void;
}

export function restoreStoppedSandboxStartupState(
  sandboxName: string,
  deps: SandboxStartupStateDeps = {},
): void {
  if ((deps.agent ?? "openclaw") === "openclaw") {
    (deps.restoreLockedStartupAccess ?? restoreLockedStartupAccess)(sandboxName);
  }
  (deps.restoreProcessState ?? restoreProcessState)(sandboxName);
}

export interface SandboxStartDeps {
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  restoreStartupState?: (sandboxName: string) => void;
  verifyGateway?: (sandboxName: string) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Restart a stopped sandbox through the lifecycle facet bound to its durable
 * provider identity, then restore startup state before verifying readiness and
 * host forwards.
 */
export async function startSandbox(
  sandboxName: string,
  deps: SandboxStartDeps = {},
): Promise<SandboxLifecycleResult> {
  const log = deps.log ?? console.log;
  const sandbox = (deps.getSandbox ?? registry.getSandbox)(sandboxName);
  const resolved = resolveSandboxLifecycleProvider(
    sandboxName,
    sandbox,
    "start",
    deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  if (!resolved.ok) return resolved.result;

  const input = {
    environment: deps.environment ?? process.env,
    log,
    sandbox: resolved.sandbox,
    sandboxName,
  };
  const preflight = resolved.bundle.preflightDoctor.preflightLifecycle("start", input);
  if (preflight) return preflight;
  const result = resolved.lifecycle.start(input);
  if (result.exitCode !== 0) return result;

  await resolved.lifecycle.verifyStarted(input, async (name) => {
    log("  Restoring sandbox startup state…");
    const restoreStartupState =
      deps.restoreStartupState ??
      ((sandboxNameToRestore: string) =>
        restoreStoppedSandboxStartupState(sandboxNameToRestore, {
          agent: resolved.sandbox.agent,
        }));
    restoreStartupState(name);
    log("  Checking gateway health and host forwards…");
    await (deps.verifyGateway ?? verifyGateway)(name);
  });
  return { exitCode: 0 };
}
