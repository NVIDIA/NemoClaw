// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import type { OpenShellSandboxObserver } from "../../adapters/openshell/sandbox-observer";
import { retryUntilAsync } from "../../core/retry";
import { cliName } from "../../onboard/branding";
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
import { hermesPortableLifecycleLockOptions, withSandboxLifecycleLock } from "./gateway-state";
import { getPersistedSandboxTargetGatewayName } from "./gateway-target";
import { isSandboxGatewayRunningForStatus } from "./status/process-recovery";
import {
  resolveSandboxLifecycleProvider,
  type SandboxLifecycleResult,
} from "./runtime/lifecycle-runtime";

function verifyGateway(sandboxName: string): Promise<void> {
  const { connectSandbox } = require("./connect") as typeof import("./connect");
  return connectSandbox(sandboxName, {
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

export interface SandboxStartDeps {
  allowDockerRuntimeInspection?: boolean;
  observer?: OpenShellSandboxObserver;
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  updateSandbox?: typeof registry.updateSandbox;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  verifyGateway?: (sandboxName: string) => Promise<void>;
  probeGatewayProcess?: typeof isSandboxGatewayRunningForStatus;
  delayGatewayProcessProbe?: (delayMs: number) => Promise<void>;
  probeInferenceInvocation?: typeof probeSandboxInferenceInvocation;
  withLifecycleLock?: typeof withSandboxLifecycleLock;
  log?: (message: string) => void;
}

const HERMES_GATEWAY_PROCESS_SETTLEMENT_ATTEMPTS = 3;
const HERMES_GATEWAY_PROCESS_SETTLEMENT_DELAY_MS = 2_000;

/** Wait only for a definitively stopped Hermes gateway after this command started its sandbox. */
async function waitForStartedHermesGatewayProcess(
  sandboxName: string,
  sandbox: SandboxEntry,
  deps: SandboxStartDeps,
  log: (message: string) => void,
): Promise<boolean | null | undefined> {
  if (sandbox.agent !== "hermes" || sandbox.stopped !== true) return undefined;
  const gatewayName = getPersistedSandboxTargetGatewayName(sandbox);
  return await retryUntilAsync(
    () => (deps.probeGatewayProcess ?? isSandboxGatewayRunningForStatus)(sandboxName, gatewayName),
    {
      accept: (running) => running !== false,
      retryDelaysMs: Array.from(
        { length: HERMES_GATEWAY_PROCESS_SETTLEMENT_ATTEMPTS - 1 },
        () => HERMES_GATEWAY_PROCESS_SETTLEMENT_DELAY_MS,
      ),
      onRetry: (_running, delayMs) => {
        log(`  Hermes gateway is still starting; checking again in ${delayMs / 1_000} seconds…`);
      },
      sleep: deps.delayGatewayProcessProbe ?? sleep,
    },
  );
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
  return await (deps.probeInferenceInvocation ?? probeSandboxInferenceInvocation)(
    {
      sandboxName,
      gatewayName,
      ...(sandbox.agent === "langchain-deepagents-code" ? { agentName: sandbox.agent } : {}),
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
  const sandbox = (deps.getSandbox ?? registry.getSandbox)(sandboxName);
  const resolved = resolveSandboxLifecycleProvider(
    sandboxName,
    sandbox,
    "start",
    deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  if (!resolved.ok) return resolved.result;

  const input = {
    readRegistry: deps.getSandbox ?? registry.getSandbox,
    environment: deps.environment ?? process.env,
    log,
    sandbox: resolved.sandbox,
    sandboxName,
  };
  const preflight = resolved.bundle.preflightDoctor.preflightLifecycle("start", input);
  if (preflight) return preflight;
  const result = await resolved.lifecycle.start(input);
  if (result.exitCode !== 0) return result;
  if (
    resolved.sandbox.stopped === true &&
    !registry.recordSandboxStopIntent(
      sandboxName,
      false,
      deps.updateSandbox ?? registry.updateSandbox,
    )
  ) {
    throw new Error(
      `Sandbox '${sandboxName}' started, but NemoClaw could not clear its intentional-stop record. Run '${cliName()} ${sandboxName} status' before another lifecycle command.`,
    );
  }
  if ("hermesPortableVerified" in result && result.hermesPortableVerified === true) {
    log("  Checking gateway health and host forwards…");
    await (deps.verifyGateway ?? verifyGateway)(sandboxName);
    return { exitCode: 0 };
  }

  const readiness: {
    gatewayProcess: boolean | null | undefined;
    inference: SandboxInferenceInvocationResult | null;
  } = {
    gatewayProcess: undefined,
    inference: null,
  };
  const settleHermesGatewayProcess =
    resolved.sandbox.agent === "hermes" && resolved.sandbox.stopped === true;
  await resolved.lifecycle.verifyStarted(input, async (name) => {
    log("  Waiting for OpenShell sandbox readiness…");
    await waitForSandboxReady(name, deps.observer, deps.allowDockerRuntimeInspection);
    readiness.gatewayProcess = await waitForStartedHermesGatewayProcess(
      name,
      resolved.sandbox,
      deps,
      log,
    );
    if (settleHermesGatewayProcess && readiness.gatewayProcess === false) return;
    log("  Checking gateway health and host forwards…");
    await (deps.verifyGateway ?? verifyGateway)(name);
    readiness.inference = await checkStartedSandboxInference(name, resolved.sandbox, deps, log);
  });
  if (settleHermesGatewayProcess && readiness.gatewayProcess === false) {
    log(
      "  The sandbox started but its Hermes gateway did not become responsive before the startup settlement window expired.",
    );
    return { exitCode: 1 };
  }
  if (readiness.inference && !readiness.inference.ok) {
    log(`  The sandbox started but inference is not usable: ${readiness.inference.detail}.`);
    log(`  Run the sandbox doctor command for '${sandboxName}' to identify the failing hop.`);
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}
