// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual, TextDecoder } from "node:util";

import type { AgentDefinition } from "../../agent/defs";
import {
  fingerprintOpenShellSandboxLiveIdentity,
  parseOpenShellSandboxId,
} from "../../adapters/openshell/sandbox-identity";
import {
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
  type PodmanSocketAuthority,
} from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import type { SandboxEntry } from "../../state/registry";
import { isPortableExperimentalProfile } from "./portable-profile";
import { defaultPortableDemoStateDir } from "./portable-runtime-receipt-readiness";
export { defaultPortableDemoStateDir as defaultHermesPortableStateDir };
import {
  assertCurrentHermesPortableContainer,
  configureHermesPortableRestartPolicy,
  enrollHermesPortableContainer,
  probeHermesPortableAuthenticatedHealth,
  type HermesPortableContainerDeps,
  type HermesPortableContainerInspection,
} from "./hermes-portable-container";
import {
  assertCurrentHermesPortableStartupContract,
  resolveHermesPortableStartupContract,
  type ResolveHermesPortableStartupContractInput,
} from "./hermes-portable-contract";
import {
  hermesPortableCreatePolicySemanticDigest,
  proveHermesPortableLivePolicy,
  type HermesPortablePolicyCapture,
} from "./hermes-portable-policy-authority";
import {
  assertHermesPortableDurablePolicyAuthority,
  captureHermesPortablePolicySource,
  createHermesPortableTransactionId,
  inspectPortableAgentReceiptAuthority,
  publishHermesPortableDurablePolicySource,
  publishHermesPortableLifecycleReceipt,
  readHermesPortableLifecycleReceipt,
  recoverableHermesPortablePolicyTransactionId,
  type HermesPortableConfiguredReceipt,
  type HermesPortableLifecycleReceipt,
  type HermesPortablePendingReceipt,
  type HermesPortableReceiptSnapshot,
} from "./hermes-portable-receipt";

export type HermesPortableSandboxObservation =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly sandboxId: string;
      readonly liveIdentityFingerprint: string;
    }
  | { readonly kind: "ambiguous"; readonly detail: string };

export type HermesPortableRegistryDisposition =
  | { readonly kind: "missing" }
  | { readonly kind: "matching"; readonly entry: SandboxEntry }
  | { readonly kind: "conflict"; readonly detail: string };

export interface HermesPortableOnboardingInput {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly runtimeAuthority: CheckpointPortableRuntimeAuthority;
  readonly stateDir: string;
  readonly createArgv: readonly string[];
  readonly createPolicyPath: string;
  readonly startup: ResolveHermesPortableStartupContractInput;
}

export interface HermesPortableOnboardingDeps<T> {
  readonly withLifecycleLock: <R>(sandboxName: string, operation: () => Promise<R>) => Promise<R>;
  readonly captureSocketAuthority?: typeof capturePodmanSocketAuthority;
  readonly container:
    | HermesPortableContainerDeps
    | ((socketAuthority: PodmanSocketAuthority) => HermesPortableContainerDeps);
  readonly capturePolicy: HermesPortablePolicyCapture;
  readonly observeSandbox: () => HermesPortableSandboxObservation;
  readonly createSandbox: (createArgv: readonly string[]) => Promise<T>;
  readonly registryDisposition: (
    receipt: HermesPortableLifecycleReceipt,
  ) => HermesPortableRegistryDisposition;
  readonly registerSandbox: (
    result: T | null,
    receipt: HermesPortableConfiguredReceipt,
    liveIdentityFingerprint: string,
  ) => void | Promise<void>;
  readonly afterRegistryCommit?: () => void | Promise<void>;
  readonly cleanupTemporaryPolicy?: () => boolean;
}

export interface HermesPortableOnboardingResult<T> {
  readonly active: HermesPortableReceiptSnapshot;
  readonly createResult: T | null;
  readonly created: boolean;
}

export interface HermesPortableOpenShellResult {
  readonly status: number | null;
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
  readonly error?: Error;
}

/** Adapt the existing synchronous runner to bounded, byte-preserving OpenShell captures. */
export function createHermesPortableOpenShellCapture(
  run: typeof import("../../runner").run,
  openshellArgv: (args: string[]) => string[],
): (args: readonly string[]) => HermesPortableOpenShellResult & {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
} {
  return (args) => {
    const result = run(openshellArgv([...args]), {
      ignoreError: true,
      suppressOutput: true,
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
    return {
      status: result.status,
      stdout: Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? "", "utf8"),
      stderr: Buffer.isBuffer(result.stderr)
        ? result.stderr
        : Buffer.from(result.stderr ?? "", "utf8"),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(message: string): never {
  throw new Error(`Hermes portable onboarding ${message}`);
}

export function isHermesPortableLifecycleMode(
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isPortableExperimentalProfile(env) && agent?.name === "hermes";
}

export function createHermesPortableContainerDeps(
  socketAuthority: PodmanSocketAuthority,
): HermesPortableContainerDeps {
  const engine = createPodmanContainerEngine({
    operation: "state-mutation",
    socketAuthority,
  });
  return {
    podman: (args, timeoutMs) => engine.capture(args, timeoutMs),
    assertSocketAuthority: () => engine.assertAuthority(),
  };
}

export function rewriteHermesPortableCreatePolicyArgv(
  createArgv: readonly string[],
  sourcePath: string,
  durablePath: string,
): string[] {
  const rewritten = [...createArgv];
  let matches = 0;
  for (let index = 0; index < rewritten.length; index += 1) {
    const argument = rewritten[index]!;
    if (argument === "--policy") {
      matches += 1;
      if (rewritten[index + 1] !== sourcePath) {
        fail("create argv policy option does not name the captured source");
      }
      rewritten[index + 1] = durablePath;
      index += 1;
    } else if (argument.startsWith("--policy=")) {
      fail("create argv must use one canonical '--policy <path>' option");
    }
  }
  if (matches !== 1) fail("create argv must contain exactly one canonical policy option");
  return rewritten;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function strictOpenShellText(value: string | Buffer): string {
  if (typeof value === "string") return value;
  try {
    return UTF8.decode(value);
  } catch {
    fail("OpenShell returned output that is not strict UTF-8");
  }
}

/** Prove gateway reachability before interpreting one exact not-found response as absence. */
export function observeHermesPortableSandbox(
  sandboxName: string,
  gatewayName: string,
  capture: (args: readonly string[]) => HermesPortableOpenShellResult,
): HermesPortableSandboxObservation {
  const list = capture(["sandbox", "list", "-g", gatewayName]);
  if (list.status !== 0 || list.error) {
    return { kind: "ambiguous", detail: "the selected OpenShell gateway is not proven reachable" };
  }
  const current = capture(["sandbox", "get", "-g", gatewayName, sandboxName]);
  if (current.status === 0 && !current.error) {
    const output = strictOpenShellText(current.stdout);
    const sandboxId = parseOpenShellSandboxId(output);
    const liveIdentityFingerprint = fingerprintOpenShellSandboxLiveIdentity(output);
    return sandboxId && liveIdentityFingerprint
      ? { kind: "present", sandboxId, liveIdentityFingerprint }
      : { kind: "ambiguous", detail: "sandbox get returned no exact durable sandbox ID" };
  }
  if (current.error || current.status === null) {
    return { kind: "ambiguous", detail: "sandbox get ended without a status-bearing response" };
  }
  const output =
    `${strictOpenShellText(current.stderr)}\n${strictOpenShellText(current.stdout)}`.trim();
  const named = new RegExp(
    `^(?:Error:\\s*)?sandbox ['\"]?${escapedRegExp(sandboxName)}['\"]? not found\\.?$`,
    "u",
  );
  const coded = /^Error: code: 'NotFound', message: "sandbox not found"$/u;
  return named.test(output) || coded.test(output)
    ? { kind: "absent" }
    : { kind: "ambiguous", detail: "sandbox get did not prove exact sandbox absence" };
}

export function classifyHermesPortableRegistry(
  receipt: HermesPortableLifecycleReceipt,
  entry: SandboxEntry | null,
): HermesPortableRegistryDisposition {
  if (!entry) return { kind: "missing" };
  if (
    entry.name !== receipt.sandboxName ||
    entry.agent !== "hermes" ||
    entry.gatewayName !== receipt.gatewayName ||
    entry.lifecycleGeneration !== receipt.lifecycleGeneration ||
    entry.openshellDriver !== "docker"
  ) {
    return { kind: "conflict", detail: "the saved row has another agent, gateway, or generation" };
  }
  return { kind: "matching", entry };
}

function commonReceipt(
  input: HermesPortableOnboardingInput,
  socketAuthority: PodmanSocketAuthority,
) {
  return {
    schemaVersion: 5 as const,
    agent: "hermes" as const,
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    lifecycleGeneration: input.lifecycleGeneration,
    runtimeAuthority: input.runtimeAuthority,
    socketAuthority,
    startup: resolveHermesPortableStartupContract(input.startup),
  };
}

function assertCurrentTransaction(
  receipt: HermesPortableLifecycleReceipt,
  input: HermesPortableOnboardingInput,
  socketAuthority: PodmanSocketAuthority,
  currentIntendedSemanticSha256: string,
): void {
  if (
    receipt.sandboxName !== input.sandboxName ||
    receipt.gatewayName !== input.gatewayName ||
    receipt.lifecycleGeneration !== input.lifecycleGeneration ||
    !isDeepStrictEqual(receipt.runtimeAuthority, input.runtimeAuthority) ||
    !isDeepStrictEqual(receipt.socketAuthority, socketAuthority)
  ) {
    fail("saved transaction disagrees with current sandbox, generation, or runtime authority");
  }
  assertCurrentHermesPortableStartupContract(receipt.startup, input.startup);
  if (currentIntendedSemanticSha256 !== receipt.policy.intendedSemanticSha256) {
    fail("saved transaction disagrees with the current create policy intent");
  }
  assertHermesPortableDurablePolicyAuthority(receipt.policy);
}

function proveLivePolicy(
  receipt: HermesPortableLifecycleReceipt,
  capture: HermesPortablePolicyCapture,
): string {
  const durable = assertHermesPortableDurablePolicyAuthority(receipt.policy);
  const proof = proveHermesPortableLivePolicy({
    gatewayName: receipt.gatewayName,
    sandboxName: receipt.sandboxName,
    createPolicyBytes: durable,
    capture,
  });
  if (proof.intendedSemanticSha256 !== receipt.policy.intendedSemanticSha256) {
    fail("live policy proof disagrees with pending intent");
  }
  return proof.verifiedLivePolicySemanticSha256;
}

function assertRegistryMissingBeforeConfiguration(
  receipt: HermesPortableLifecycleReceipt,
  disposition: HermesPortableRegistryDisposition,
): void {
  if (disposition.kind === "missing") return;
  fail(
    disposition.kind === "conflict"
      ? `registry conflicts with ${receipt.phase} authority: ${disposition.detail}`
      : `registry is already committed while receipt phase is '${receipt.phase}'`,
  );
}

function requireMatchingRegistry(
  receipt: HermesPortableLifecycleReceipt,
  disposition: HermesPortableRegistryDisposition,
  liveIdentityFingerprint: string,
): void {
  if (
    disposition.kind === "matching" &&
    disposition.entry.lifecycleLiveIdentityFingerprint === liveIdentityFingerprint
  ) {
    return;
  }
  fail(
    disposition.kind === "conflict"
      ? `registry conflicts with ${receipt.phase} authority: ${disposition.detail}`
      : disposition.kind === "missing"
        ? `registry is missing for receipt phase '${receipt.phase}'`
        : `registry live identity disagrees with receipt phase '${receipt.phase}'`,
  );
}

function requireCurrentOpenShellIdentity(
  receipt: HermesPortableConfiguredReceipt,
  observation: HermesPortableSandboxObservation,
): Extract<HermesPortableSandboxObservation, { readonly kind: "present" }> {
  if (observation.kind !== "present" || observation.sandboxId !== receipt.container.sandboxId) {
    fail("current OpenShell sandbox identity disagrees with the receipt container");
  }
  return observation;
}

function requireCurrentReceiptSnapshot<T extends HermesPortableLifecycleReceipt>(
  expected: HermesPortableReceiptSnapshot & { readonly receipt: T },
  stateDir: string,
): HermesPortableReceiptSnapshot & { readonly receipt: T } {
  const current = readHermesPortableLifecycleReceipt(expected.receipt.sandboxName, stateDir);
  if (
    !current ||
    current.path !== expected.path ||
    current.identity.dev !== expected.identity.dev ||
    current.identity.ino !== expected.identity.ino ||
    current.sha256 !== expected.sha256 ||
    !current.bytes.equals(expected.bytes)
  ) {
    fail("receipt authority changed during lifecycle verification");
  }
  return current as HermesPortableReceiptSnapshot & { readonly receipt: T };
}

function requireConfiguredReceiptSnapshot(
  snapshot: HermesPortableReceiptSnapshot,
): HermesPortableReceiptSnapshot & { readonly receipt: HermesPortableConfiguredReceipt } {
  if (snapshot.receipt.phase === "pending") fail("configured receipt authority is required");
  return snapshot as HermesPortableReceiptSnapshot & {
    readonly receipt: HermesPortableConfiguredReceipt;
  };
}

function requireConfiguredContainerReady(container: HermesPortableContainerInspection): void {
  if (
    !container.authority.running ||
    container.paused ||
    container.authority.restartPolicy !== "unless-stopped"
  ) {
    fail("exact container is not running with the committed restart policy");
  }
}

function configuringReceipt(
  pending: HermesPortableReceiptSnapshot,
  livePolicyDigest: string,
  container: HermesPortableContainerInspection,
): HermesPortableConfiguredReceipt {
  if (pending.receipt.phase !== "pending") fail("configuring requires pending authority");
  return {
    ...pending.receipt,
    phase: "configuring",
    previousPhaseSha256: pending.sha256,
    verifiedLivePolicySemanticSha256: livePolicyDigest,
    container: container.authority,
  };
}

function activeReceipt(
  configuring: HermesPortableReceiptSnapshot,
  container: HermesPortableContainerInspection,
): HermesPortableConfiguredReceipt {
  if (configuring.receipt.phase !== "configuring") fail("active requires configuring authority");
  return {
    ...configuring.receipt,
    phase: "active",
    previousPhaseSha256: configuring.sha256,
    container: container.authority,
  };
}

/**
 * Hold one sandbox lifecycle fence across reservation, create, registry commit,
 * and active publication. Every retry resumes the highest immutable phase.
 */
export async function runHermesPortableOnboardingTransaction<T>(
  input: HermesPortableOnboardingInput,
  deps: HermesPortableOnboardingDeps<T>,
): Promise<HermesPortableOnboardingResult<T>> {
  return await deps.withLifecycleLock(input.sandboxName, async () => {
    const temporaryPolicy = captureHermesPortablePolicySource(input.createPolicyPath);
    const currentIntendedSemanticSha256 = hermesPortableCreatePolicySemanticDigest(
      temporaryPolicy.bytes,
    );
    const socketAuthority = (deps.captureSocketAuthority ?? capturePodmanSocketAuthority)(
      input.runtimeAuthority.socketPath,
    );
    const containerDeps =
      typeof deps.container === "function" ? deps.container(socketAuthority) : deps.container;
    const recoverableTransactionId = recoverableHermesPortablePolicyTransactionId(
      input.sandboxName,
      input.stateDir,
    );
    const authority = recoverableTransactionId
      ? { kind: "none" as const }
      : inspectPortableAgentReceiptAuthority(input.sandboxName, input.stateDir);
    if (authority.kind === "openclaw") fail("will not reinterpret OpenClaw lifecycle authority");
    let snapshot = authority.kind === "hermes" ? authority.snapshot : null;
    let createArgv: readonly string[];
    if (snapshot) {
      assertCurrentTransaction(
        snapshot.receipt,
        input,
        socketAuthority,
        currentIntendedSemanticSha256,
      );
      createArgv = rewriteHermesPortableCreatePolicyArgv(
        input.createArgv,
        input.createPolicyPath,
        snapshot.receipt.policy.sourcePath,
      );
    } else {
      const transactionId = recoverableTransactionId ?? createHermesPortableTransactionId();
      const policy = publishHermesPortableDurablePolicySource({
        sandboxName: input.sandboxName,
        transactionId,
        stateDir: input.stateDir,
        intendedSemanticSha256: currentIntendedSemanticSha256,
        source: temporaryPolicy,
      });
      createArgv = rewriteHermesPortableCreatePolicyArgv(
        input.createArgv,
        input.createPolicyPath,
        policy.sourcePath,
      );
      const pending: HermesPortablePendingReceipt = {
        ...commonReceipt(input, socketAuthority),
        transactionId,
        phase: "pending",
        policy,
      };
      snapshot = publishHermesPortableLifecycleReceipt(pending, input.stateDir);
    }
    if (deps.cleanupTemporaryPolicy && !deps.cleanupTemporaryPolicy()) {
      fail("temporary policy cleanup did not complete after durable reservation");
    }

    let createResult: T | null = null;
    let created = false;
    if (snapshot.receipt.phase === "active") {
      let activeSnapshot = requireConfiguredReceiptSnapshot(snapshot);
      const liveIdentity = requireCurrentOpenShellIdentity(
        activeSnapshot.receipt,
        deps.observeSandbox(),
      );
      requireConfiguredContainerReady(
        assertCurrentHermesPortableContainer(activeSnapshot.receipt, containerDeps),
      );
      proveLivePolicy(activeSnapshot.receipt, deps.capturePolicy);
      requireMatchingRegistry(
        activeSnapshot.receipt,
        deps.registryDisposition(activeSnapshot.receipt),
        liveIdentity.liveIdentityFingerprint,
      );
      probeHermesPortableAuthenticatedHealth(activeSnapshot.receipt, containerDeps);
      activeSnapshot = requireCurrentReceiptSnapshot(activeSnapshot, input.stateDir);
      const finalIdentity = requireCurrentOpenShellIdentity(
        activeSnapshot.receipt,
        deps.observeSandbox(),
      );
      requireConfiguredContainerReady(
        assertCurrentHermesPortableContainer(activeSnapshot.receipt, containerDeps),
      );
      proveLivePolicy(activeSnapshot.receipt, deps.capturePolicy);
      requireMatchingRegistry(
        activeSnapshot.receipt,
        deps.registryDisposition(activeSnapshot.receipt),
        finalIdentity.liveIdentityFingerprint,
      );
      return { active: activeSnapshot, createResult, created };
    }

    if (snapshot.receipt.phase === "pending") {
      assertRegistryMissingBeforeConfiguration(
        snapshot.receipt,
        deps.registryDisposition(snapshot.receipt),
      );
      let observation = deps.observeSandbox();
      if (observation.kind === "ambiguous")
        fail(`cannot classify create effects: ${observation.detail}`);
      if (observation.kind === "absent") {
        assertCurrentTransaction(
          snapshot.receipt,
          input,
          socketAuthority,
          currentIntendedSemanticSha256,
        );
        createResult = await deps.createSandbox(createArgv);
        created = true;
        observation = deps.observeSandbox();
      }
      if (observation.kind !== "present") {
        fail(
          observation.kind === "ambiguous"
            ? `cannot classify create result: ${observation.detail}`
            : "create returned without exact live sandbox authority",
        );
      }
      assertCurrentTransaction(
        snapshot.receipt,
        input,
        socketAuthority,
        currentIntendedSemanticSha256,
      );
      const livePolicyDigest = proveLivePolicy(snapshot.receipt, deps.capturePolicy);
      const container = enrollHermesPortableContainer(
        snapshot.receipt,
        observation.sandboxId,
        containerDeps,
      );
      snapshot = publishHermesPortableLifecycleReceipt(
        configuringReceipt(snapshot, livePolicyDigest, container),
        input.stateDir,
      );
    }

    if (snapshot.receipt.phase !== "configuring") fail("transaction has an unsupported phase");
    let configuringSnapshot = requireConfiguredReceiptSnapshot(snapshot);
    assertCurrentTransaction(
      configuringSnapshot.receipt,
      input,
      socketAuthority,
      currentIntendedSemanticSha256,
    );
    let liveIdentity = requireCurrentOpenShellIdentity(
      configuringSnapshot.receipt,
      deps.observeSandbox(),
    );
    proveLivePolicy(configuringSnapshot.receipt, deps.capturePolicy);
    configureHermesPortableRestartPolicy(configuringSnapshot.receipt, containerDeps);
    const beforeRegistry = deps.registryDisposition(configuringSnapshot.receipt);
    if (beforeRegistry.kind === "conflict") {
      fail(`registry conflicts with configuring authority: ${beforeRegistry.detail}`);
    }
    if (beforeRegistry.kind === "missing") {
      await deps.registerSandbox(
        createResult,
        configuringSnapshot.receipt,
        liveIdentity.liveIdentityFingerprint,
      );
      await deps.afterRegistryCommit?.();
    }
    assertCurrentTransaction(
      configuringSnapshot.receipt,
      input,
      socketAuthority,
      currentIntendedSemanticSha256,
    );
    liveIdentity = requireCurrentOpenShellIdentity(
      configuringSnapshot.receipt,
      deps.observeSandbox(),
    );
    proveLivePolicy(configuringSnapshot.receipt, deps.capturePolicy);
    const currentContainer = assertCurrentHermesPortableContainer(
      configuringSnapshot.receipt,
      containerDeps,
    );
    requireConfiguredContainerReady(currentContainer);
    requireMatchingRegistry(
      configuringSnapshot.receipt,
      deps.registryDisposition(configuringSnapshot.receipt),
      liveIdentity.liveIdentityFingerprint,
    );
    probeHermesPortableAuthenticatedHealth(configuringSnapshot.receipt, containerDeps);
    configuringSnapshot = requireCurrentReceiptSnapshot(configuringSnapshot, input.stateDir);
    liveIdentity = requireCurrentOpenShellIdentity(
      configuringSnapshot.receipt,
      deps.observeSandbox(),
    );
    proveLivePolicy(configuringSnapshot.receipt, deps.capturePolicy);
    requireConfiguredContainerReady(
      assertCurrentHermesPortableContainer(configuringSnapshot.receipt, containerDeps),
    );
    requireMatchingRegistry(
      configuringSnapshot.receipt,
      deps.registryDisposition(configuringSnapshot.receipt),
      liveIdentity.liveIdentityFingerprint,
    );
    const active = publishHermesPortableLifecycleReceipt(
      activeReceipt(configuringSnapshot, currentContainer),
      input.stateDir,
    );
    return { active, createResult, created };
  });
}

/** Assemble the existing onboarding transaction without changing its lifecycle fence. */
export async function runHermesPortableOnboardingFromOnboard<T>(
  sandboxName: string,
  gatewayName: string,
  lifecycleGeneration: string,
  runtimeAuthority: CheckpointPortableRuntimeAuthority,
  createArgv: readonly string[],
  createPolicyPath: string,
  startup: ResolveHermesPortableStartupContractInput,
  withLifecycleLock: HermesPortableOnboardingDeps<T>["withLifecycleLock"],
  runOpenShell: typeof import("../../runner").run,
  openshellArgv: (args: string[]) => string[],
  createSandbox: HermesPortableOnboardingDeps<T>["createSandbox"],
  readRegistry: () => SandboxEntry | null,
  registerSandbox: HermesPortableOnboardingDeps<T>["registerSandbox"],
  cleanupTemporaryPolicy: () => boolean,
): Promise<HermesPortableOnboardingResult<T>> {
  const captureOpenShell = createHermesPortableOpenShellCapture(runOpenShell, openshellArgv);
  return runHermesPortableOnboardingTransaction(
    {
      sandboxName,
      gatewayName,
      lifecycleGeneration,
      runtimeAuthority,
      stateDir: defaultPortableDemoStateDir(process.env),
      createArgv,
      createPolicyPath,
      startup,
    },
    {
      withLifecycleLock,
      container: createHermesPortableContainerDeps,
      capturePolicy: captureOpenShell,
      observeSandbox: () =>
        observeHermesPortableSandbox(sandboxName, gatewayName, captureOpenShell),
      createSandbox,
      registryDisposition: (receipt) => classifyHermesPortableRegistry(receipt, readRegistry()),
      registerSandbox,
      cleanupTemporaryPolicy,
    },
  );
}
