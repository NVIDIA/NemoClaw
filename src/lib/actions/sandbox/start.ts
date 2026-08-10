// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  probeSandboxInferenceInvocation,
  READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  type SandboxInferenceInvocationResult,
} from "./inference-invocation-probe";
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
  probeInferenceInvocation?: typeof probeSandboxInferenceInvocation;
  log?: (message: string) => void;
}

/**
 * A started gateway that answers the /v1/models probe can still reject an
 * inference request, so start sends one inference request with the recorded
 * provider and model before it reports success. A registry entry with no
 * provider or no model has nothing to request, so start skips the request
 * instead of failing.
 */
function checkStartedSandboxInference(
  sandboxName: string,
  sandbox: SandboxEntry,
  deps: SandboxStartDeps,
  log: (message: string) => void,
): SandboxInferenceInvocationResult | null {
  const model = (sandbox.model ?? "").trim();
  const provider = (sandbox.provider ?? "").trim();
  if (!model || !provider) return null;
  log("  Checking that the sandbox serves an agent request…");
  return (deps.probeInferenceInvocation ?? probeSandboxInferenceInvocation)(
    {
      sandboxName,
      provider,
      model,
      preferredInferenceApi: sandbox.preferredInferenceApi ?? null,
    },
    {},
    READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  );
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

  const readiness: { inference: SandboxInferenceInvocationResult | null } = { inference: null };
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
    readiness.inference = checkStartedSandboxInference(name, resolved.sandbox, deps, log);
  });
  if (readiness.inference && !readiness.inference.ok) {
    log(`  The sandbox started but inference is not usable: ${readiness.inference.detail}.`);
    log(`  Run the sandbox doctor command for '${sandboxName}' to identify the failing hop.`);
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}
