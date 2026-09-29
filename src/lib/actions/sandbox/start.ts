// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import type { OpenShellSandboxObserver } from "../../adapters/openshell/sandbox-observer";
import { retryUntilAsync } from "../../core/retry";
import { DEFAULT_SANDBOX_EXEC_TIMEOUT_MS } from "../../adapters/sandbox/command-transport";
import { cliName } from "../../onboard/branding";
import {
  classifyRegisteredPortableAgentLifecycle,
  qualifyLegacyHermesPortableLifecycleProfile,
  recoverPortableAgentSandboxLifecycle,
  requalifyPortableAgentSandboxAuthority,
} from "../../onboard/experimental/portable-agent-lifecycle";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../onboard/runtime-provider/access";
import type { SandboxEntry } from "../../state/registry";
import * as registry from "../../state/registry";
import {
  findSandboxAcrossGatewayRoots,
  getSandboxAcrossGatewayRoots,
  recordSandboxStopIntentInOwningGatewayRegistry,
} from "../../state/registry/cross-port";
import {
  probeSandboxInferenceInvocation,
  READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
  type SandboxInferenceInvocationResult,
} from "./inference-invocation-probe";
import { isTransientInferenceInvocationFailure } from "./inference-route-health";
import { hermesPortableLifecycleLockOptions, withSandboxLifecycleLock } from "./gateway-state";
import { getPersistedSandboxTargetGatewayName } from "./gateway-target";
import {
  isSandboxGatewayRunningForStatus,
  resolveGatewayRecoveryWaitSeconds,
  waitForStartedHermesGatewayProcess,
} from "./status/process-recovery";
import {
  resolveSandboxLifecycleProvider,
  type SandboxLifecycleResult,
} from "./runtime/lifecycle-runtime";
import {
  mutateStandardSandboxLifecycle,
  type StandardSandboxLifecycleDeps,
} from "./runtime/standard-lifecycle";

function verifyGateway(
  sandboxName: string,
  options: { managedHermesGatewayProcessObserved?: true } = {},
): Promise<void> {
  const { connectSandbox } = require("./connect") as typeof import("./connect");
  return connectSandbox(sandboxName, {
    ...options,
    probeOnly: true,
    requireLaunchReadinessPublication: false,
  });
}

/** Wait for a just-started sandbox while tolerating its bounded transient Error phase. */
async function waitForSandboxReady(
  sandboxName: string,
  observer?: OpenShellSandboxObserver,
  allowDockerRuntimeInspection = true,
): Promise<void> {
  const { waitForSandboxReadyOrExit, SANDBOX_REPAIR_READY_TIMEOUT_SEC } =
    require("./connect") as typeof import("./connect");
  await waitForSandboxReadyOrExit(sandboxName, {
    allowInitialErrorAfterStart: true,
    allowDockerRuntimeInspection,
    ...(observer ? { observer } : {}),
    defaultTimeoutSec: SANDBOX_REPAIR_READY_TIMEOUT_SEC,
    retryCommand: "start",
  });
}

export interface SandboxStartDeps extends StandardSandboxLifecycleDeps {
  allowDockerRuntimeInspection?: boolean;
  observer?: OpenShellSandboxObserver;
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  updateSandbox?: typeof registry.updateSandbox;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  verifyGateway?: (sandboxName: string) => Promise<void>;
  probeGatewayProcess?: typeof isSandboxGatewayRunningForStatus;
  delayGatewayProcessProbe?: (delayMs: number) => Promise<void>;
  now?: () => number;
  probeInferenceInvocation?: typeof probeSandboxInferenceInvocation;
  qualifyLegacyPortableProfile?: typeof qualifyLegacyHermesPortableLifecycleProfile;
  recoverPortableSandbox?: typeof recoverPortableAgentSandboxLifecycle;
  requalifyPortableSandbox?: typeof requalifyPortableAgentSandboxAuthority;
  delayInferenceInvocationProbe?: (delayMs: number) => Promise<void>;
  withLifecycleLock?: typeof withSandboxLifecycleLock;
  log?: (message: string) => void;
}

const GATEWAY_PROCESS_SETTLEMENT_DELAY_MS = 2_000;
const START_INFERENCE_SETTLEMENT_DELAYS_MS = [2_000, 2_000] as const;

/** Observe native startup only after an intentional stop; never relaunch the agent here. */
async function waitForStartedNativeGatewayProcess(
  sandboxName: string,
  sandbox: SandboxEntry,
  deps: SandboxStartDeps,
  log: (message: string) => void,
): Promise<boolean | null | undefined> {
  const nativeAgent = sandbox.agent ?? "openclaw";
  if ((nativeAgent !== "hermes" && nativeAgent !== "openclaw") || sandbox.stopped !== true) {
    return undefined;
  }
  const gatewayName = getPersistedSandboxTargetGatewayName(sandbox);
  const probe = deps.probeGatewayProcess ?? isSandboxGatewayRunningForStatus;
  const delay = async (delayMs: number) => {
    log(`  Native agent gateway is still starting; checking again in ${delayMs / 1_000} seconds…`);
    await (deps.delayGatewayProcessProbe ?? sleep)(delayMs);
  };
  if (nativeAgent === "hermes") {
    return await waitForStartedHermesGatewayProcess(sandboxName, gatewayName, {
      probe,
      ...(deps.delayGatewayProcessProbe ? { sleep: deps.delayGatewayProcessProbe } : {}),
      log,
    });
  }

  const now = deps.now ?? (() => performance.now());
  const deadline =
    now() + resolveGatewayRecoveryWaitSeconds(undefined, deps.environment ?? process.env) * 1_000;
  while (now() < deadline) {
    const remaining = Math.floor(deadline - now());
    if (remaining < 1) break;
    const running = await probe(sandboxName, gatewayName, {
      startup: { timeoutMs: Math.min(DEFAULT_SANDBOX_EXEC_TIMEOUT_MS, remaining) },
    });
    if (now() >= deadline) break;
    if (running !== false) return running;
    await delay(Math.min(GATEWAY_PROCESS_SETTLEMENT_DELAY_MS, deadline - now()));
  }
  return false;
}

/**
 * A started gateway that answers the /v1/models probe can still reject an
 * inference request, so start sends one inference request with the recorded
 * provider and model before it reports success. A registry entry with no
 * provider or no model has nothing to request, so start skips the request
 * instead of failing.
 */
async function checkStartedSandboxInference(
  sandboxName: string,
  sandbox: SandboxEntry,
  deps: SandboxStartDeps,
  log: (message: string) => void,
): Promise<SandboxInferenceInvocationResult | null> {
  const model = (sandbox.model ?? "").trim();
  const provider = (sandbox.provider ?? "").trim();
  if (!model || !provider) return null;
  const gatewayName = getPersistedSandboxTargetGatewayName(sandbox);
  log("  Checking that the sandbox serves an agent request…");
  const input = {
    sandboxName,
    gatewayName,
    ...(sandbox.agent === "langchain-deepagents-code" ? { agentName: sandbox.agent } : {}),
    provider,
    model,
    preferredInferenceApi: sandbox.preferredInferenceApi ?? null,
  };
  const probe = () =>
    (deps.probeInferenceInvocation ?? probeSandboxInferenceInvocation)(
      input,
      {},
      READINESS_INFERENCE_INVOCATION_TIMEOUT_MS,
    );
  if (sandbox.agent !== "hermes" && sandbox.agent !== "pi") return await probe();
  return await retryUntilAsync(probe, {
    accept: (result) =>
      sandbox.agent === "pi"
        ? result.ok || result.httpStatus !== 503
        : !isTransientInferenceInvocationFailure(result),
    retryDelaysMs: START_INFERENCE_SETTLEMENT_DELAYS_MS,
    onRetry: (result, delayMs, attempt) =>
      log(
        `  Inference request returned HTTP ${result.ok ? "unknown" : result.httpStatus}; ` +
          `checking again in ${delayMs / 1_000} seconds ` +
          `(attempt ${attempt + 1}/${START_INFERENCE_SETTLEMENT_DELAYS_MS.length + 1})…`,
      ),
    sleep: deps.delayInferenceInvocationProbe ?? sleep,
  });
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
  const environment = deps.environment ?? process.env;
  return (deps.withLifecycleLock ?? withSandboxLifecycleLock)(
    sandboxName,
    () => startSandboxWithinLifecycleFence(sandboxName, deps),
    hermesPortableLifecycleLockOptions(sandboxName, environment),
  );
}

async function startSandboxWithinLifecycleFence(
  sandboxName: string,
  deps: SandboxStartDeps,
): Promise<SandboxLifecycleResult> {
  const log = deps.log ?? console.log;
  const owningRegistryHit = deps.getSandbox ? null : findSandboxAcrossGatewayRoots(sandboxName);
  const readSandbox = deps.getSandbox ?? getSandboxAcrossGatewayRoots;
  const sandbox = owningRegistryHit?.entry ?? readSandbox(sandboxName);
  const resolved = resolveSandboxLifecycleProvider(
    sandboxName,
    sandbox,
    "start",
    deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  if (!resolved.ok) return resolved.result;

  const input = {
    readRegistry: readSandbox,
    environment: deps.environment ?? process.env,
    gatewayName: getPersistedSandboxTargetGatewayName(resolved.sandbox),
    log,
    sandbox: resolved.sandbox,
    sandboxName,
  };
  const preflight = resolved.bundle.preflightDoctor.preflightLifecycle("start", input);
  if (preflight) return preflight;
  let result: SandboxLifecycleResult & { readonly hermesPortableVerified?: true };
  try {
    const portableAuthority = classifyRegisteredPortableAgentLifecycle(
      sandboxName,
      resolved.bundle.identity.id,
      resolved.sandbox,
      {
        env: input.environment,
        readRegistry: (name) => input.readRegistry?.(name) ?? null,
        ...(deps.qualifyLegacyPortableProfile
          ? { qualifyLegacyHermes: deps.qualifyLegacyPortableProfile }
          : {}),
      },
    );
    const portableAuthorityRecorded = portableAuthority.kind === "portable";
    if (portableAuthorityRecorded && resolved.sandbox.agent === "hermes") {
      await (deps.requalifyPortableSandbox ?? requalifyPortableAgentSandboxAuthority)(sandboxName, {
        env: input.environment,
        readRegistry: (name) => input.readRegistry?.(name) ?? null,
      });
    }
    const portable = portableAuthorityRecorded
      ? await (deps.recoverPortableSandbox ?? recoverPortableAgentSandboxLifecycle)(
          sandboxName,
          {
            agent: resolved.sandbox.agent,
            gatewayName: resolved.sandbox.gatewayName ?? "nemoclaw",
            lifecycleGeneration: resolved.sandbox.lifecycleGeneration,
            openshellDriver: resolved.sandbox.openshellDriver,
            provider: resolved.sandbox.provider,
          },
          {
            env: input.environment,
            log,
            readRegistry: (name) => input.readRegistry?.(name) ?? null,
          },
        )
      : ({ kind: "not-installed" } as const);
    result =
      portable.kind !== "not-installed"
        ? resolved.sandbox.agent === "hermes"
          ? { exitCode: 0, hermesPortableVerified: true }
          : { exitCode: 0 }
        : await mutateStandardSandboxLifecycle("start", input, deps);
  } catch (error) {
    return { exitCode: 1, message: error instanceof Error ? error.message : String(error) };
  }
  if (result.exitCode !== 0) return result;
  const clearIntentionalStop = () => {
    if (resolved.sandbox.stopped !== true) return;
    const recorded = deps.updateSandbox
      ? registry.recordSandboxStopIntent(sandboxName, false, deps.updateSandbox)
      : owningRegistryHit
        ? recordSandboxStopIntentInOwningGatewayRegistry(owningRegistryHit, false)
        : false;
    if (!recorded) {
      throw new Error(
        `Sandbox '${sandboxName}' started, but NemoClaw could not clear its intentional-stop record. Run '${cliName()} ${sandboxName} status' before another lifecycle command.`,
      );
    }
  };
  if ("hermesPortableVerified" in result && result.hermesPortableVerified === true) {
    log("  Checking gateway health and host forwards…");
    await (deps.verifyGateway ?? verifyGateway)(sandboxName);
    clearIntentionalStop();
    return { exitCode: 0 };
  }

  const readiness: {
    gatewayProcess: boolean | null | undefined;
    inference: SandboxInferenceInvocationResult | null;
  } = {
    gatewayProcess: undefined,
    inference: null,
  };
  log("  Waiting for OpenShell sandbox readiness…");
  await waitForSandboxReady(sandboxName, deps.observer, deps.allowDockerRuntimeInspection);
  readiness.gatewayProcess = await waitForStartedNativeGatewayProcess(
    sandboxName,
    resolved.sandbox,
    deps,
    log,
  );
  if (readiness.gatewayProcess !== false) {
    log("  Checking gateway health and host forwards…");
    if (deps.verifyGateway) {
      await deps.verifyGateway(sandboxName);
    } else if (resolved.sandbox.agent === "hermes" && readiness.gatewayProcess === true) {
      await verifyGateway(sandboxName, { managedHermesGatewayProcessObserved: true });
    } else {
      await verifyGateway(sandboxName);
    }
    readiness.inference = await checkStartedSandboxInference(
      sandboxName,
      resolved.sandbox,
      deps,
      log,
    );
  }
  if (readiness.gatewayProcess === false) {
    log(
      "  The sandbox started but its native agent gateway did not become responsive before the startup settlement window expired.",
    );
    return { exitCode: 1 };
  }
  if (readiness.inference && !readiness.inference.ok) {
    log(`  The sandbox started but inference is not usable: ${readiness.inference.detail}.`);
    log(`  Run the sandbox doctor command for '${sandboxName}' to identify the failing hop.`);
    return { exitCode: 1 };
  }
  clearIntentionalStop();
  return { exitCode: 0 };
}
