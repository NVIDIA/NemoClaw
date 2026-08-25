// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";

import type { AgentDefinition } from "../../../agent/definition-types";
import { resolveSelectableAgentDefinition } from "../../../agent/list-command";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
} from "../../../onboard/runtime-provider/access";
import type {
  RuntimeProviderQuarantineAuthority,
  RuntimeProviderQuarantineInput,
  RuntimeProviderQuarantineStepResult,
} from "../../../onboard/runtime-provider/contract";
import { boundedSecretFreeText } from "../../../security/secret-free-text";
import { getConfiguredMessagingChannelsFromEntry } from "../../../state/registry-messaging";
import {
  readSandboxQuarantineReceipt,
  sandboxQuarantineReceiptPath,
  type SandboxQuarantineReceipt,
  writeSandboxQuarantineReceipt,
} from "../../../state/registry/quarantine-receipt";
import {
  beginSandboxQuarantine,
  getSandboxForQuarantine,
  releaseSandboxQuarantine as clearSandboxQuarantine,
  updateSandboxQuarantine,
} from "../../../state/registry/quarantine-operations";
import type {
  SandboxQuarantineAttempt,
  SandboxQuarantineFence,
  SandboxQuarantineOperation,
  SandboxQuarantinePhase,
} from "../../../state/registry/types";
import { stopAgentForwardPortsForStop } from "../../../tunnel/agent-forward-stop";
import { stopSandboxChannels } from "../../../tunnel/sandbox-gateway-stop";
import { teardownSandboxDashboardForward } from "../forward-recovery";
import { withSandboxLifecycleLockSync } from "../gateway-state";
import { getPersistedSandboxTargetGatewayBinding } from "../gateway-target";
import { resolveSandboxLifecycleProvider } from "../runtime/lifecycle-runtime";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const REQUIRED_FINAL_OPERATIONS = [
  "messaging-stop",
  "dashboard-stop",
  "service-access-stop",
  "workload-stop",
  "execution-observation",
  "sandbox-access-observation",
] as const satisfies readonly SandboxQuarantineOperation[];

export interface QuarantineSandboxOptions {
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface QuarantineSandboxResult {
  readonly exitCode: number;
  readonly status: "quarantined" | "partial" | "conflict" | "failed" | "released";
  readonly message: string;
  readonly fenceId?: string;
  readonly idempotencyKey?: string;
  readonly receiptPath?: string;
  readonly receipt?: SandboxQuarantineReceipt;
  readonly outcomes?: {
    readonly executionObservation: SandboxQuarantineAttempt["outcome"] | "not attempted";
    readonly sandboxAccessObservation: SandboxQuarantineAttempt["outcome"] | "not attempted";
    readonly serviceAccessStop: SandboxQuarantineAttempt["outcome"] | "not attempted";
  };
}

export interface QuarantineSandboxDeps {
  readonly beginFence?: typeof beginSandboxQuarantine;
  readonly clearFence?: typeof clearSandboxQuarantine;
  readonly getSandbox?: typeof getSandboxForQuarantine;
  readonly getAgent?: (name: string, environment: NodeJS.ProcessEnv) => AgentDefinition | null;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly readReceipt?: typeof readSandboxQuarantineReceipt;
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
  readonly stopMessaging?: typeof stopSandboxChannels;
  readonly stopServiceAccess?: typeof stopAgentForwardPortsForStop;
  readonly teardownDashboard?: typeof teardownSandboxDashboardForward;
  readonly updateFence?: typeof updateSandboxQuarantine;
  readonly withLifecycleLock?: typeof withSandboxLifecycleLockSync;
  readonly writeReceipt?: typeof writeSandboxQuarantineReceipt;
  readonly log?: (message: string) => void;
}

interface QuarantineIsolationPlan {
  readonly stopMessaging: boolean;
  readonly stopDashboard: boolean;
  readonly stopServiceAccess: boolean;
}

function resolveQualifiedAgent(
  sandbox: { readonly agent?: string | null },
  deps: QuarantineSandboxDeps,
): AgentDefinition | null {
  const environment = process.env;
  const agentName = sandbox.agent ?? "openclaw";
  if (deps.getAgent) return deps.getAgent(agentName, environment);
  return resolveSelectableAgentDefinition(agentName, environment);
}

function buildIsolationPlan(
  sandbox: Parameters<typeof getConfiguredMessagingChannelsFromEntry>[0],
  agent: AgentDefinition,
): QuarantineIsolationPlan {
  const gatewayRuntime = agent.runtime?.kind !== "terminal";
  const declaredForwardPorts = agent.forward_ports ?? [];
  return {
    stopMessaging: getConfiguredMessagingChannelsFromEntry(sandbox).length > 0,
    stopDashboard: gatewayRuntime && agent.hasDashboard === true && declaredForwardPorts.length > 0,
    stopServiceAccess: declaredForwardPorts.length > 0,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedSafeText(value: unknown, maxBytes: number, fallback: string): string {
  return boundedSecretFreeText(value, maxBytes, fallback);
}

function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length === 0 || Buffer.byteLength(key, "utf8") > 256 || CONTROL_CHARACTERS.test(key)) {
    CONTROL_CHARACTERS.lastIndex = 0;
    throw new Error("Quarantine idempotency key must be 1-256 bytes without control characters");
  }
  CONTROL_CHARACTERS.lastIndex = 0;
  return key;
}

function attempt(
  operation: SandboxQuarantineOperation,
  outcome: SandboxQuarantineAttempt["outcome"],
  at: string,
  detail?: unknown,
): SandboxQuarantineAttempt {
  return {
    operation,
    outcome,
    attemptedAt: at,
    ...(detail === undefined ? {} : { detail: boundedSafeText(detail, 512, "operation failed") }),
  };
}

function withAttempt(
  fence: SandboxQuarantineFence,
  entry: SandboxQuarantineAttempt,
  phase: SandboxQuarantinePhase = fence.phase,
): SandboxQuarantineFence {
  return {
    ...fence,
    phase,
    updatedAt: entry.attemptedAt,
    attempts: [...fence.attempts, entry].slice(-32),
  };
}

function latestOperationSucceeded(
  attempts: readonly SandboxQuarantineAttempt[],
  operation: SandboxQuarantineOperation,
): boolean {
  return (
    [...attempts].reverse().find((entry) => entry.operation === operation)?.outcome === "succeeded"
  );
}

function latestOperationOutcome(
  attempts: readonly SandboxQuarantineAttempt[],
  operation: SandboxQuarantineOperation,
): SandboxQuarantineAttempt["outcome"] | "not attempted" {
  return (
    [...attempts].reverse().find((entry) => entry.operation === operation)?.outcome ??
    "not attempted"
  );
}

function outcomeSummary(
  attempts: readonly SandboxQuarantineAttempt[],
): NonNullable<QuarantineSandboxResult["outcomes"]> {
  return {
    executionObservation: latestOperationOutcome(attempts, "execution-observation"),
    sandboxAccessObservation: latestOperationOutcome(attempts, "sandbox-access-observation"),
    serviceAccessStop: latestOperationOutcome(attempts, "service-access-stop"),
  };
}

function receiptFor(
  fence: SandboxQuarantineFence,
  status: SandboxQuarantineReceipt["status"],
  completedAt: string | null,
  releasedAt: string | null = null,
): SandboxQuarantineReceipt {
  return {
    schemaVersion: 1,
    kind: "sandbox-quarantine-receipt",
    status,
    fence,
    completedAt,
    releasedAt,
  };
}

function failed(message: string): QuarantineSandboxResult {
  return { exitCode: 1, status: "failed", message };
}

function resultFromPriorReceipt(
  receipt: SandboxQuarantineReceipt,
  receiptPath: string,
): QuarantineSandboxResult {
  const status =
    receipt.status === "active"
      ? "partial"
      : receipt.status === "released"
        ? "released"
        : receipt.status;
  return {
    exitCode: receipt.status === "partial" || receipt.status === "active" ? 2 : 0,
    status,
    message:
      receipt.status === "released"
        ? `Quarantine request ${receipt.fence.requestIdentity} was already released.`
        : `Quarantine request ${receipt.fence.requestIdentity} already completed as ${receipt.status}.`,
    fenceId: receipt.fence.fenceId,
    receiptPath,
    receipt,
    outcomes: outcomeSummary(receipt.fence.attempts),
  };
}

function sameQuarantineTarget(
  left: SandboxQuarantineFence["target"],
  right: SandboxQuarantineFence["target"],
): boolean {
  return (
    left.sandboxName === right.sandboxName &&
    left.providerId === right.providerId &&
    left.gatewayName === right.gatewayName &&
    left.gatewayPort === right.gatewayPort &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.liveIdentityFingerprint === right.liveIdentityFingerprint &&
    left.providerHandle === right.providerHandle &&
    left.providerLifecycleGeneration === right.providerLifecycleGeneration &&
    left.runtime.kind === right.runtime.kind &&
    left.runtime.handle === right.runtime.handle
  );
}

function authorityFromTarget(
  target: SandboxQuarantineFence["target"],
): RuntimeProviderQuarantineAuthority {
  return {
    schemaVersion: 1,
    providerId: target.providerId,
    sandboxName: target.sandboxName,
    gatewayName: target.gatewayName,
    gatewayPort: target.gatewayPort,
    lifecycleGeneration: target.lifecycleGeneration,
    liveIdentityFingerprint: target.liveIdentityFingerprint,
    providerHandle: target.providerHandle,
    providerLifecycleGeneration: target.providerLifecycleGeneration,
    runtime: { ...target.runtime },
  };
}

/** Compare identity that is stable across the quarantine stop itself. */
function sameReleasedTargetAuthority(
  target: SandboxQuarantineFence["target"],
  current: RuntimeProviderQuarantineAuthority,
): boolean {
  return (
    target.sandboxName === current.sandboxName &&
    target.providerId === current.providerId &&
    target.gatewayName === current.gatewayName &&
    target.gatewayPort === current.gatewayPort &&
    target.lifecycleGeneration === current.lifecycleGeneration &&
    target.liveIdentityFingerprint === current.liveIdentityFingerprint &&
    target.runtime.kind === current.runtime.kind &&
    target.runtime.handle === current.runtime.handle
  );
}

function persistJournal(
  sandboxName: string,
  fence: SandboxQuarantineFence,
  update: typeof updateSandboxQuarantine,
): boolean {
  try {
    return update(sandboxName, fence);
  } catch {
    return false;
  }
}

function quarantineWithinLifecycleLock(
  sandboxName: string,
  options: QuarantineSandboxOptions,
  deps: QuarantineSandboxDeps,
): QuarantineSandboxResult {
  const getSandbox = deps.getSandbox ?? getSandboxForQuarantine;
  const now = deps.now ?? (() => new Date());
  const generatedKey = options.idempotencyKey === undefined;
  let idempotencyKey: string;
  try {
    idempotencyKey = validateIdempotencyKey(
      options.idempotencyKey ?? (deps.randomId ?? randomUUID)(),
    );
  } catch (error) {
    return failed(boundedSafeText(error, 512, "Quarantine idempotency key is invalid."));
  }
  const requestIdentity = sha256(idempotencyKey);
  const reasonDigest = sha256(options.reason);
  const sandbox = getSandbox(sandboxName);
  if (!sandbox) return failed(`Sandbox '${sandboxName}' is not registered.`);
  if (sandbox.quarantine && sandbox.quarantine.requestIdentity !== requestIdentity) {
    return {
      exitCode: 1,
      status: "conflict",
      message:
        `Sandbox '${sandboxName}' is already quarantined by fence ${sandbox.quarantine.fenceId}. ` +
        "Use the original idempotency key to reconcile it or release that fence explicitly.",
      fenceId: sandbox.quarantine.fenceId,
    };
  }
  if (sandbox.quarantine && sandbox.quarantine.reasonDigest !== reasonDigest) {
    return {
      exitCode: 1,
      status: "conflict",
      message: "The existing quarantine request uses the same idempotency key with another reason.",
      fenceId: sandbox.quarantine.fenceId,
    };
  }

  let agent: AgentDefinition | null;
  try {
    agent = resolveQualifiedAgent(sandbox, deps);
  } catch (error) {
    return failed(boundedSafeText(error, 512, "Sandbox agent manifest is invalid."));
  }
  if (!agent?.quarantineQualification) {
    return failed(
      `Sandbox agent '${sandbox.agent ?? "openclaw"}' is not qualified for quarantine; refusing before mutation.`,
    );
  }
  const isolationPlan = buildIsolationPlan(sandbox, agent);

  const resolved = resolveSandboxLifecycleProvider(
    sandboxName,
    sandbox,
    "stop",
    deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  if (!resolved.ok)
    return failed(
      boundedSafeText(
        resolved.result.message,
        512,
        "Runtime provider cannot quarantine this sandbox.",
      ),
    );
  const providerQuarantine = resolved.bundle.quarantine;
  if (providerQuarantine.supported !== true) {
    return failed(
      boundedSafeText(
        `Runtime provider '${resolved.bundle.identity.id}' does not support quarantine: ${providerQuarantine.reason}`,
        512,
        "Runtime provider does not support quarantine.",
      ),
    );
  }
  const lifecycleInput = {
    environment: process.env,
    log: deps.log ?? console.log,
    sandbox: resolved.sandbox,
    sandboxName,
  };
  const providerPreflight = resolved.bundle.preflightDoctor.preflightLifecycle(
    "stop",
    lifecycleInput,
  );
  if (providerPreflight) {
    return failed(
      boundedSafeText(
        providerPreflight.message,
        512,
        "Runtime provider quarantine preflight failed.",
      ),
    );
  }
  if (!sandbox.lifecycleGeneration || !sandbox.lifecycleLiveIdentityFingerprint) {
    return failed(
      `Sandbox '${sandboxName}' has no exact lifecycle generation and live identity; refusing quarantine before mutation.`,
    );
  }

  let gatewayName: string;
  let gatewayPort: number | null;
  try {
    const gateway = getPersistedSandboxTargetGatewayBinding(sandbox);
    gatewayName = gateway.name;
    gatewayPort = gateway.port;
  } catch (error) {
    return failed(boundedSafeText(error, 512, "Sandbox gateway identity is invalid."));
  }
  if (gatewayPort === null) return failed("Sandbox gateway identity is ambiguous.");
  const receiptPath = sandboxQuarantineReceiptPath(sandboxName, gatewayPort, requestIdentity);
  let priorReceipt: SandboxQuarantineReceipt | null;
  try {
    priorReceipt = (deps.readReceipt ?? readSandboxQuarantineReceipt)(receiptPath);
  } catch (error) {
    return failed(boundedSafeText(error, 512, "Cannot safely read the prior quarantine receipt."));
  }
  if (priorReceipt) {
    if (
      priorReceipt.fence.requestIdentity !== requestIdentity ||
      priorReceipt.fence.reasonDigest !== reasonDigest ||
      priorReceipt.fence.target.sandboxName !== sandboxName ||
      priorReceipt.fence.target.gatewayName !== gatewayName ||
      priorReceipt.fence.target.gatewayPort !== gatewayPort
    ) {
      return failed("The prior quarantine receipt does not match this request and target.");
    }
    if (sandbox.quarantine) {
      if (
        priorReceipt.status === "released" ||
        priorReceipt.fence.fenceId !== sandbox.quarantine.fenceId
      ) {
        return failed("The active quarantine fence disagrees with its durable receipt.");
      }
      if (priorReceipt.status === "quarantined" && sandbox.quarantine.phase === "quarantined") {
        return resultFromPriorReceipt(priorReceipt, receiptPath);
      }
    } else if (priorReceipt.status === "released") {
      return resultFromPriorReceipt(priorReceipt, receiptPath);
    }
  }

  const quarantineInput: RuntimeProviderQuarantineInput = {
    ...lifecycleInput,
    gatewayName,
    gatewayPort,
    lifecycleGeneration: sandbox.lifecycleGeneration,
    liveIdentityFingerprint: sandbox.lifecycleLiveIdentityFingerprint,
  };
  const durableFence =
    sandbox.quarantine ??
    (priorReceipt && priorReceipt.status !== "released" ? priorReceipt.fence : null);
  let authority: RuntimeProviderQuarantineAuthority;
  if (durableFence) {
    authority = authorityFromTarget(durableFence.target);
  } else {
    try {
      authority = providerQuarantine.prepare(quarantineInput);
    } catch (error) {
      return failed(
        boundedSafeText(error, 512, "Exact quarantine authority could not be prepared."),
      );
    }
  }

  const target: SandboxQuarantineFence["target"] = {
    sandboxName: authority.sandboxName,
    providerId: authority.providerId,
    gatewayName: authority.gatewayName,
    gatewayPort: authority.gatewayPort,
    lifecycleGeneration: authority.lifecycleGeneration,
    liveIdentityFingerprint: authority.liveIdentityFingerprint,
    providerHandle: authority.providerHandle,
    providerLifecycleGeneration: authority.providerLifecycleGeneration,
    runtime: { ...authority.runtime },
  };
  if (sandbox.quarantine && !sameQuarantineTarget(sandbox.quarantine.target, target)) {
    return {
      exitCode: 2,
      status: "partial",
      message: "The quarantined runtime identity changed; the existing fence was left active.",
      fenceId: sandbox.quarantine.fenceId,
      receiptPath,
    };
  }
  if (
    priorReceipt &&
    priorReceipt.status !== "released" &&
    !sameQuarantineTarget(priorReceipt.fence.target, target)
  ) {
    return failed("The prior quarantine receipt refers to a stale or replaced runtime target.");
  }

  const startedAt = now().toISOString();
  const candidate: SandboxQuarantineFence = priorReceipt
    ? {
        ...priorReceipt.fence,
        updatedAt: startedAt,
        phase: "fenced",
        target,
      }
    : {
        schemaVersion: 1,
        fenceId: (deps.randomId ?? randomUUID)(),
        requestIdentity,
        reasonDigest,
        createdAt: startedAt,
        updatedAt: startedAt,
        phase: "fenced",
        target,
        attempts: [attempt("fence-persistence", "succeeded", startedAt)],
      };

  let fence: SandboxQuarantineFence;
  if (sandbox.quarantine) {
    fence = sandbox.quarantine;
  } else {
    let begun;
    try {
      begun = (deps.beginFence ?? beginSandboxQuarantine)(sandboxName, candidate);
    } catch (error) {
      return failed(boundedSafeText(error, 512, "Quarantine fence persistence failed."));
    }
    if (!("fence" in begun)) {
      return failed("Sandbox registry identity changed before the quarantine fence was persisted.");
    }
    if (begun.status === "conflict") {
      return {
        exitCode: 1,
        status: "conflict",
        message: `Sandbox '${sandboxName}' was fenced by another quarantine request.`,
        fenceId: begun.fence.fenceId,
      };
    }
    fence = begun.fence;
  }

  const update = deps.updateFence ?? updateSandboxQuarantine;
  const writeReceipt = deps.writeReceipt ?? writeSandboxQuarantineReceipt;
  let journalHealthy = true;
  try {
    writeReceipt(receiptPath, receiptFor(fence, "active", null));
    fence = withAttempt(fence, attempt("receipt-persistence", "succeeded", now().toISOString()));
  } catch (error) {
    fence = withAttempt(
      fence,
      attempt("receipt-persistence", "failed", now().toISOString(), error),
      "partial",
    );
  }
  journalHealthy = persistJournal(sandboxName, fence, update) && journalHealthy;

  const runBooleanOperation = (operation: SandboxQuarantineOperation, run: () => boolean): void => {
    const at = now().toISOString();
    try {
      const succeeded = run();
      fence = withAttempt(
        fence,
        attempt(
          operation,
          succeeded ? "succeeded" : "failed",
          at,
          succeeded ? undefined : `${operation} did not confirm completion`,
        ),
        "stopping",
      );
    } catch (error) {
      fence = withAttempt(fence, attempt(operation, "failed", at, error), "stopping");
    }
    journalHealthy = persistJournal(sandboxName, fence, update) && journalHealthy;
  };

  runBooleanOperation(
    "messaging-stop",
    () =>
      !isolationPlan.stopMessaging ||
      (deps.stopMessaging ?? stopSandboxChannels)(sandboxName, {
        channelStopTransport: resolved.lifecycle.channelStopTransport,
        info: (message) =>
          lifecycleInput.log(`  ${boundedSafeText(message, 512, "Messaging stop update.")}`),
        warn: (message) =>
          lifecycleInput.log(
            `  Warning: ${boundedSafeText(message, 512, "Messaging stop warning.")}`,
          ),
      }) === true,
  );
  runBooleanOperation(
    "dashboard-stop",
    () =>
      !isolationPlan.stopDashboard ||
      (deps.teardownDashboard ?? teardownSandboxDashboardForward)(sandboxName),
  );
  runBooleanOperation(
    "service-access-stop",
    () =>
      !isolationPlan.stopServiceAccess ||
      (deps.stopServiceAccess ?? stopAgentForwardPortsForStop)(sandboxName, {
        info: (message) =>
          lifecycleInput.log(`  ${boundedSafeText(message, 512, "Access stop update.")}`),
        warn: (message) =>
          lifecycleInput.log(`  Warning: ${boundedSafeText(message, 512, "Access stop warning.")}`),
      }) === true,
  );

  const workloadAt = now().toISOString();
  try {
    const outcome = providerQuarantine.stop(quarantineInput, authority);
    fence = withAttempt(
      fence,
      attempt("workload-stop", outcome.outcome, workloadAt, outcome.detail),
      "stopping",
    );
  } catch (error) {
    fence = withAttempt(fence, attempt("workload-stop", "failed", workloadAt, error), "stopping");
  }
  journalHealthy = persistJournal(sandboxName, fence, update) && journalHealthy;

  fence = { ...fence, phase: "verifying", updatedAt: now().toISOString() };
  journalHealthy = persistJournal(sandboxName, fence, update) && journalHealthy;
  let observation: {
    execution: RuntimeProviderQuarantineStepResult;
    sandboxAccess: RuntimeProviderQuarantineStepResult;
  };
  try {
    observation = providerQuarantine.observe(quarantineInput, authority);
  } catch {
    observation = {
      execution: {
        outcome: "inconclusive",
        detail: "The exact runtime state could not be independently observed.",
      },
      sandboxAccess: {
        outcome: "inconclusive",
        detail: "Sandbox access could not be independently observed.",
      },
    };
  }
  fence = withAttempt(
    fence,
    attempt(
      "execution-observation",
      observation.execution.outcome,
      now().toISOString(),
      observation.execution.detail,
    ),
    "verifying",
  );
  journalHealthy = persistJournal(sandboxName, fence, update) && journalHealthy;
  fence = withAttempt(
    fence,
    attempt(
      "sandbox-access-observation",
      observation.sandboxAccess.outcome,
      now().toISOString(),
      observation.sandboxAccess.detail,
    ),
    "verifying",
  );

  const enforced = REQUIRED_FINAL_OPERATIONS.every((operation) =>
    latestOperationSucceeded(fence.attempts, operation),
  );
  const completedAt = now().toISOString();
  fence = {
    ...fence,
    phase: enforced && journalHealthy ? "quarantined" : "partial",
    updatedAt: completedAt,
  };
  journalHealthy = persistJournal(sandboxName, fence, update) && journalHealthy;
  if (!journalHealthy && fence.phase !== "partial") {
    fence = { ...fence, phase: "partial", updatedAt: now().toISOString() };
    persistJournal(sandboxName, fence, update);
  }

  let receipt = receiptFor(
    fence,
    fence.phase === "quarantined" ? "quarantined" : "partial",
    completedAt,
  );
  let receiptWritten = true;
  try {
    writeReceipt(receiptPath, receipt);
  } catch (error) {
    receiptWritten = false;
    fence = withAttempt(
      fence,
      attempt("receipt-persistence", "failed", now().toISOString(), error),
      "partial",
    );
    persistJournal(sandboxName, fence, update);
    receipt = receiptFor(fence, "partial", completedAt);
  }
  const complete = fence.phase === "quarantined" && receiptWritten;
  return {
    exitCode: complete ? 0 : 2,
    status: complete ? "quarantined" : "partial",
    message: complete
      ? `Sandbox '${sandboxName}' is quarantined. The restart fence remains active until explicit release.`
      : `Sandbox '${sandboxName}' quarantine is partial. The restart fence remains active; no rollback was attempted.`,
    fenceId: fence.fenceId,
    ...(generatedKey ? { idempotencyKey } : {}),
    receiptPath,
    receipt,
    outcomes: outcomeSummary(fence.attempts),
  };
}

/** Persist the fence first, then stop and observe every isolation surface. */
export function quarantineSandbox(
  sandboxName: string,
  options: QuarantineSandboxOptions,
  deps: QuarantineSandboxDeps = {},
): QuarantineSandboxResult {
  return (deps.withLifecycleLock ?? withSandboxLifecycleLockSync)(sandboxName, () =>
    quarantineWithinLifecycleLock(sandboxName, options, deps),
  );
}

/** Explicitly remove a matching fence. This operation never starts the sandbox. */
export function releaseSandboxQuarantine(
  sandboxName: string,
  fenceId: string,
  deps: QuarantineSandboxDeps = {},
): QuarantineSandboxResult {
  return (deps.withLifecycleLock ?? withSandboxLifecycleLockSync)(sandboxName, () => {
    const sandbox = (deps.getSandbox ?? getSandboxForQuarantine)(sandboxName);
    const fence = sandbox?.quarantine;
    if (!fence) return failed(`Sandbox '${sandboxName}' is not quarantined.`);
    if (fence.fenceId !== fenceId) {
      return failed(`Fence '${fenceId}' does not match sandbox '${sandboxName}'.`);
    }
    const resolved = resolveSandboxLifecycleProvider(
      sandboxName,
      sandbox,
      "stop",
      deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
    );
    if (!resolved.ok) {
      return failed(
        boundedSafeText(
          resolved.result.message,
          512,
          "Runtime provider cannot validate this quarantine release.",
        ),
      );
    }
    const providerQuarantine = resolved.bundle.quarantine;
    if (providerQuarantine.supported !== true) {
      return failed(
        boundedSafeText(
          `Runtime provider '${resolved.bundle.identity.id}' cannot validate quarantine release: ${providerQuarantine.reason}`,
          512,
          "Runtime provider cannot validate quarantine release.",
        ),
      );
    }
    const releaseInput: RuntimeProviderQuarantineInput = {
      environment: process.env,
      log: deps.log ?? console.log,
      sandbox: resolved.sandbox,
      sandboxName,
      gatewayName: fence.target.gatewayName,
      gatewayPort: fence.target.gatewayPort,
      lifecycleGeneration: fence.target.lifecycleGeneration,
      liveIdentityFingerprint: fence.target.liveIdentityFingerprint,
    };
    let currentAuthority: RuntimeProviderQuarantineAuthority;
    try {
      currentAuthority = providerQuarantine.prepare(releaseInput);
    } catch (error) {
      return failed(
        boundedSafeText(error, 512, "Cannot validate the quarantined runtime before release."),
      );
    }
    if (!sameReleasedTargetAuthority(fence.target, currentAuthority)) {
      return failed(
        "Sandbox quarantine target authority changed before release; the fence remains active.",
      );
    }
    const receiptPath = sandboxQuarantineReceiptPath(
      sandboxName,
      fence.target.gatewayPort,
      fence.requestIdentity,
    );
    const completedAt =
      fence.phase === "quarantined" || fence.phase === "partial" ? fence.updatedAt : null;
    try {
      (deps.writeReceipt ?? writeSandboxQuarantineReceipt)(
        receiptPath,
        receiptFor(fence, fence.phase === "quarantined" ? "quarantined" : "partial", completedAt),
      );
    } catch (error) {
      return failed(
        `Cannot preserve the quarantine receipt before release: ${boundedSafeText(error, 512, "receipt write failed")}`,
      );
    }
    const releasedAt = (deps.now ?? (() => new Date()))().toISOString();
    const releasedReceipt = receiptFor(fence, "released", completedAt, releasedAt);
    try {
      (deps.writeReceipt ?? writeSandboxQuarantineReceipt)(receiptPath, releasedReceipt);
    } catch (error) {
      return {
        exitCode: 2,
        status: "partial",
        message:
          `Sandbox '${sandboxName}' quarantine release could not persist its final receipt; ` +
          `the fence remains active: ${boundedSafeText(error, 512, "receipt write failed")}`,
        fenceId,
        receiptPath,
      };
    }
    if (!(deps.clearFence ?? clearSandboxQuarantine)(sandboxName, fenceId)) {
      return failed(
        "Sandbox quarantine authority changed before release; the fence remains active.",
      );
    }
    return {
      exitCode: 0,
      status: "released",
      message: `Sandbox '${sandboxName}' quarantine was released. The sandbox remains stopped.`,
      fenceId,
      receiptPath,
      receipt: releasedReceipt,
    };
  });
}

export const QUARANTINE_RELEASE_GUIDANCE =
  "Release does not start the sandbox. Start it separately with the sandbox start command.";
