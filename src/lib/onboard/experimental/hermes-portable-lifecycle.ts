// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  fingerprintOpenShellSandboxLiveIdentity,
  parseOpenShellSandboxId,
} from "../../adapters/openshell/sandbox-identity";
import { classifyOpenShellSandboxPresence } from "../../adapters/openshell/sandbox-presence";
import { assertPodmanSocketAuthority } from "../../adapters/podman";
import {
  assertHermesPortableOpenShellExecutableAuthority,
  buildOpenShellSubprocessEnv,
  HERMES_PORTABLE_OPENSHELL_VERSION,
  type HermesPortableOpenShellExecutableAuthority,
} from "../../adapters/openshell/resolve-shared";
import { isMcpLifecycleLockHeld } from "../../state/mcp-lifecycle-lock-acquisition";
import type { SandboxEntry } from "../../state/registry/types";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../runtime-provider/podman-lifecycle";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import {
  assertCurrentHermesPortableContainer,
  observeHermesPortableAuthenticatedHealth,
  startHermesPortableContainer,
  stopHermesPortableContainer,
  type HermesPortableContainerDeps,
  type HermesPortableContainerInspection,
  type HermesPortablePodmanResult,
} from "./hermes-portable-container";
import {
  createHermesPortablePodmanCommandAuthority,
  type HermesPortablePodmanAuthorityDeps,
} from "./hermes-portable-podman-authority";
import { assertCurrentHermesPortableStoredStartupContract } from "./hermes-portable-contract";
import {
  proveHermesPortableLivePolicy,
  type HermesPortablePolicyCaptureResult,
} from "./hermes-portable-policy-authority";
import {
  assertHermesPortableDurablePolicyAuthority,
  readHermesPortableLifecycleReceipt,
  type HermesPortableConfiguredReceipt,
  type HermesPortableLifecycleReceipt,
  type HermesPortableReceiptSnapshot,
} from "./hermes-portable-receipt";
import type {
  PortableDemoLifecycleContext,
  PortableDemoLifecycleRecoveryResult,
  PortableDemoLifecycleStopResult,
} from "./portable-demo-lifecycle";
import { defaultPortableDemoStateDir } from "./portable-runtime-receipt-readiness";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const COMMAND_TIMEOUT_MS = 5_000;
const EXEC_READY_TIMEOUT_MS = 90_000;
const STARTUP_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export interface HermesPortableLifecycleCommandResult {
  readonly status: number | null;
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
  readonly error?: Error;
}

export interface HermesPortableLifecycleDeps {
  readonly stateDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readRegistry?: (sandboxName: string) => SandboxEntry | null;
  readonly captureOpenShell?: (
    args: readonly string[],
    timeoutMs: number,
  ) => HermesPortableLifecycleCommandResult;
  readonly launchOpenShell?: (args: readonly string[]) => void;
  readonly assertOpenShellExecutableAuthority?: (
    authority: HermesPortableOpenShellExecutableAuthority,
    childEnv: NodeJS.ProcessEnv,
    resolutionEnv: NodeJS.ProcessEnv,
  ) => string;
  readonly container?:
    | HermesPortableContainerDeps
    | ((receipt: HermesPortableConfiguredReceipt) => HermesPortableContainerDeps);
  readonly podmanAuthorityDeps?: HermesPortablePodmanAuthorityDeps;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => void;
  readonly log?: (message: string) => void;
}

interface QualifiedHermesPortableLifecycle {
  readonly snapshot: HermesPortableReceiptSnapshot & {
    readonly receipt: HermesPortableConfiguredReceipt;
  };
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly containerDeps: HermesPortableContainerDeps;
  readonly container: HermesPortableContainerInspection;
  readonly capture: NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]>;
}

function fail(message: string): never {
  throw new Error(`Hermes portable lifecycle ${message}`);
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds > 0) Atomics.wait(SLEEP_BUFFER, 0, 0, milliseconds);
}

function commandOutput(value: string | Buffer, label: string): string {
  if (typeof value === "string") return value;
  try {
    return UTF8.decode(value);
  } catch {
    fail(`${label} is not strict UTF-8`);
  }
}

function defaultCaptureOpenShell(
  binary: string,
  commandEnv: NodeJS.ProcessEnv,
  runtimeAuthority: HermesPortableConfiguredReceipt["runtimeAuthority"],
): NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]> {
  const env = buildHermesPortableOpenShellEnv(commandEnv, runtimeAuthority);
  return (args, timeoutMs) => {
    const result = spawnSync(binary, [...args], {
      env,
      maxBuffer: 512 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr ?? Buffer.alloc(0),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

function defaultLaunchOpenShell(
  binary: string,
  commandEnv: NodeJS.ProcessEnv,
  runtimeAuthority: HermesPortableConfiguredReceipt["runtimeAuthority"],
): (args: readonly string[]) => void {
  const env = buildHermesPortableOpenShellEnv(commandEnv, runtimeAuthority);
  return (args) => {
    const child = spawn(binary, [...args], {
      detached: true,
      env,
      shell: false,
      stdio: "ignore",
    });
    child.once("error", () => undefined);
    child.unref();
  };
}

export function buildHermesPortableOpenShellEnv(
  commandEnv: NodeJS.ProcessEnv,
  runtimeAuthority?: HermesPortableConfiguredReceipt["runtimeAuthority"],
): NodeJS.ProcessEnv {
  return buildOpenShellSubprocessEnv(commandEnv, runtimeAuthority);
}

export interface HermesPortableOpenShellCommandAuthority {
  readonly env: NodeJS.ProcessEnv;
  readonly executablePath: string;
}

/** Requalify the exact schema-5 executable and child environment for one command. */
export function buildHermesPortableOpenShellCommandAuthority(
  receipt: HermesPortableLifecycleReceipt,
  commandEnv: NodeJS.ProcessEnv,
  assertAuthority: NonNullable<
    HermesPortableLifecycleDeps["assertOpenShellExecutableAuthority"]
  > = assertHermesPortableOpenShellExecutableAuthority,
): HermesPortableOpenShellCommandAuthority {
  const env = buildHermesPortableOpenShellEnv(commandEnv, receipt.runtimeAuthority);
  return {
    env,
    executablePath: assertAuthority(receipt.openshellExecutableAuthority, env, commandEnv),
  };
}

function createContainerDeps(
  receipt: HermesPortableConfiguredReceipt,
  commandEnv: NodeJS.ProcessEnv,
  authorityDeps?: HermesPortablePodmanAuthorityDeps,
): HermesPortableContainerDeps {
  const authority = createHermesPortablePodmanCommandAuthority(
    receipt.podmanExecutableAuthority,
    receipt.socketAuthority,
    receipt.runtimeAuthority,
    commandEnv,
    authorityDeps,
  );
  return {
    podman: (args, timeoutMs): HermesPortablePodmanResult => {
      authority.assertCurrent();
      return authority.engine.capture(args, timeoutMs);
    },
    assertSocketAuthority: () => authority.engine.assertAuthority(),
  };
}

function sameSnapshot(
  left: HermesPortableReceiptSnapshot,
  right: HermesPortableReceiptSnapshot,
): boolean {
  return (
    left.path === right.path &&
    left.identity.dev === right.identity.dev &&
    left.identity.ino === right.identity.ino &&
    left.sha256 === right.sha256 &&
    left.bytes.equals(right.bytes)
  );
}

function contextMatches(
  receipt: HermesPortableConfiguredReceipt,
  context: PortableDemoLifecycleContext,
): boolean {
  return (
    context.agent === "hermes" &&
    context.openshellDriver === "docker" &&
    context.gatewayName === receipt.gatewayName &&
    context.lifecycleGeneration === receipt.lifecycleGeneration
  );
}

function observeOpenShellIdentity(
  receipt: HermesPortableConfiguredReceipt,
  capture: NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]>,
  acceptedPhases: readonly string[] = ["Ready"],
): { readonly sandboxId: string; readonly liveIdentityFingerprint: string } {
  const gateway = capture(["sandbox", "list", "-g", receipt.gatewayName], COMMAND_TIMEOUT_MS);
  if (gateway.status !== 0 || gateway.error) fail("cannot prove the selected gateway reachable");
  const current = capture(
    ["sandbox", "get", "-g", receipt.gatewayName, receipt.sandboxName],
    COMMAND_TIMEOUT_MS,
  );
  if (current.status !== 0 || current.error) fail("cannot prove the current OpenShell sandbox");
  const output = commandOutput(current.stdout, "sandbox identity output");
  const sandboxId = parseOpenShellSandboxId(output);
  const liveIdentityFingerprint = fingerprintOpenShellSandboxLiveIdentity(output);
  const phases = [...output.matchAll(/^Phase:\s*(\S+)\s*$/gmu)].map((match) => match[1]!);
  if (
    phases.length !== 1 ||
    !acceptedPhases.includes(phases[0]!) ||
    !sandboxId ||
    !liveIdentityFingerprint ||
    sandboxId !== receipt.container.sandboxId
  ) {
    fail("OpenShell sandbox identity disagrees with the receipt container");
  }
  return { sandboxId, liveIdentityFingerprint };
}

function policyCapture(
  capture: NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]>,
): (args: readonly string[]) => HermesPortablePolicyCaptureResult {
  return (args) => {
    const result = capture(args, COMMAND_TIMEOUT_MS);
    return {
      status: result.status,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout, "utf8"),
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr, "utf8"),
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

function requireRegistry(
  receipt: HermesPortableConfiguredReceipt,
  liveIdentityFingerprint: string,
  deps: HermesPortableLifecycleDeps,
): void {
  const entry = deps.readRegistry?.(receipt.sandboxName);
  if (
    !entry ||
    entry.name !== receipt.sandboxName ||
    entry.agent !== "hermes" ||
    entry.openshellDriver !== "docker" ||
    entry.gatewayName !== receipt.gatewayName ||
    entry.lifecycleGeneration !== receipt.lifecycleGeneration ||
    entry.lifecycleLiveIdentityFingerprint !== liveIdentityFingerprint ||
    entry.openshellVersion !== HERMES_PORTABLE_OPENSHELL_VERSION
  ) {
    fail("registry authority disagrees with the active receipt");
  }
}

function qualify(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: HermesPortableLifecycleDeps,
  expected?: HermesPortableReceiptSnapshot,
  acceptedPhases: readonly string[] = ["Ready"],
): QualifiedHermesPortableLifecycle {
  const commandEnv = deps.env ?? process.env;
  assertNoOpenShellGatewayEndpointOverride(commandEnv);
  const stateDir = deps.stateDir ?? defaultPortableDemoStateDir(commandEnv);
  const lockStateDir = path.join(stateDir, "state");
  if (!isMcpLifecycleLockHeld(sandboxName, lockStateDir)) {
    fail("mutation requires the sandbox lifecycle lock");
  }
  const snapshot = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
  if (!snapshot) fail("active receipt authority disappeared");
  if (expected && !sameSnapshot(snapshot, expected)) fail("receipt authority changed");
  if (snapshot.receipt.phase !== "active") {
    fail(`receipt phase '${snapshot.receipt.phase}' is incomplete and cannot run commands`);
  }
  const receipt = snapshot.receipt;
  if (!contextMatches(receipt, context)) fail("registry context disagrees with the active receipt");
  assertCurrentHermesPortableStoredStartupContract(receipt.startup, sandboxName);
  const durablePolicy = assertHermesPortableDurablePolicyAuthority(receipt.policy);
  const assertExecutable =
    deps.assertOpenShellExecutableAuthority ?? assertHermesPortableOpenShellExecutableAuthority;
  const initialCommandAuthority = buildHermesPortableOpenShellCommandAuthority(
    receipt,
    commandEnv,
    assertExecutable,
  );
  const rawCapture =
    deps.captureOpenShell ??
    defaultCaptureOpenShell(
      initialCommandAuthority.executablePath,
      commandEnv,
      receipt.runtimeAuthority,
    );
  const capture: NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]> = (
    args,
    timeoutMs,
  ) => {
    buildHermesPortableOpenShellCommandAuthority(receipt, commandEnv, assertExecutable);
    return rawCapture(args, timeoutMs);
  };
  const policy = proveHermesPortableLivePolicy({
    gatewayName: receipt.gatewayName,
    sandboxName,
    createPolicyBytes: durablePolicy,
    capture: policyCapture(capture),
  });
  if (
    policy.intendedSemanticSha256 !== receipt.policy.intendedSemanticSha256 ||
    policy.verifiedLivePolicySemanticSha256 !== receipt.verifiedLivePolicySemanticSha256
  ) {
    fail("live policy authority disagrees with the active receipt");
  }
  const liveIdentity = observeOpenShellIdentity(receipt, capture, acceptedPhases);
  requireRegistry(receipt, liveIdentity.liveIdentityFingerprint, deps);
  const containerDeps =
    typeof deps.container === "function"
      ? deps.container(receipt)
      : (deps.container ?? createContainerDeps(receipt, commandEnv, deps.podmanAuthorityDeps));
  const container = assertCurrentHermesPortableContainer(receipt, containerDeps);
  if (container.paused || container.authority.restartPolicy !== "unless-stopped") {
    fail("container state or restart policy disagrees with active authority");
  }
  return {
    snapshot: snapshot as QualifiedHermesPortableLifecycle["snapshot"],
    receipt,
    containerDeps,
    container,
    capture,
  };
}

function openshellExecArgs(receipt: HermesPortableConfiguredReceipt, command: readonly string[]) {
  return [
    "sandbox",
    "exec",
    "-g",
    receipt.gatewayName,
    "--name",
    receipt.sandboxName,
    "--no-tty",
    "--",
    ...command,
  ];
}

function waitFor(
  timeoutMs: number,
  deps: HermesPortableLifecycleDeps,
  probe: (remainingMs: number) => boolean,
): boolean {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  do {
    const remaining = Math.max(1, deadline - now());
    if (probe(remaining)) return true;
    sleep(Math.min(POLL_INTERVAL_MS, remaining));
  } while (now() < deadline);
  return false;
}

/** Recover the exact schema-5 container and manifest-owned Hermes startup. */
export function recoverHermesPortableSandboxLifecycle(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: HermesPortableLifecycleDeps = {},
): PortableDemoLifecycleRecoveryResult {
  let qualified = qualify(sandboxName, context, deps);
  const wasRunning = qualified.container.authority.running;
  if (!wasRunning) {
    startHermesPortableContainer(qualified.receipt, qualified.containerDeps);
    qualified = qualify(sandboxName, context, deps, qualified.snapshot);
  }
  const commandEnv = deps.env ?? process.env;
  const assertExecutable =
    deps.assertOpenShellExecutableAuthority ?? assertHermesPortableOpenShellExecutableAuthority;
  const commandAuthority = buildHermesPortableOpenShellCommandAuthority(
    qualified.receipt,
    commandEnv,
    assertExecutable,
  );
  const rawCapture =
    deps.captureOpenShell ??
    defaultCaptureOpenShell(
      commandAuthority.executablePath,
      commandEnv,
      qualified.receipt.runtimeAuthority,
    );
  const capture: NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]> = (
    args,
    timeoutMs,
  ) => {
    buildHermesPortableOpenShellCommandAuthority(qualified.receipt, commandEnv, assertExecutable);
    return rawCapture(args, timeoutMs);
  };
  const execReady = waitFor(EXEC_READY_TIMEOUT_MS, deps, (remainingMs) => {
    const result = capture(
      openshellExecArgs(qualified.receipt, ["true"]),
      Math.min(COMMAND_TIMEOUT_MS, remainingMs),
    );
    return result.status === 0 && !result.error;
  });
  if (!execReady) fail("did not reconnect to the selected OpenShell gateway");
  qualified = qualify(sandboxName, context, deps, qualified.snapshot);
  if (
    observeHermesPortableAuthenticatedHealth(qualified.receipt, qualified.containerDeps) === "ready"
  ) {
    qualify(sandboxName, context, deps, qualified.snapshot);
    return wasRunning ? { kind: "already-running" } : { kind: "recovered" };
  }
  qualified = qualify(sandboxName, context, deps, qualified.snapshot);
  const rawLaunch =
    deps.launchOpenShell ??
    defaultLaunchOpenShell(
      commandAuthority.executablePath,
      commandEnv,
      qualified.receipt.runtimeAuthority,
    );
  const launch = (args: readonly string[]): void => {
    buildHermesPortableOpenShellCommandAuthority(qualified.receipt, commandEnv, assertExecutable);
    rawLaunch(args);
  };
  launch(openshellExecArgs(qualified.receipt, qualified.receipt.startup.argv));
  const recovered = waitFor(STARTUP_TIMEOUT_MS, deps, () => {
    const current = qualify(sandboxName, context, deps, qualified.snapshot);
    return (
      observeHermesPortableAuthenticatedHealth(current.receipt, current.containerDeps) === "ready"
    );
  });
  if (!recovered) fail("managed startup did not pass authenticated health");
  qualify(sandboxName, context, deps, qualified.snapshot);
  (deps.log ?? console.log)(`  Hermes portable lifecycle recovered sandbox '${sandboxName}'.`);
  return { kind: "recovered" };
}

/** Requalify active schema-5 authority without starting or changing the sandbox. */
export function assertHermesPortableSandboxLifecycleAuthority(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: HermesPortableLifecycleDeps = {},
): void {
  const qualified = qualify(sandboxName, context, deps);
  if (!qualified.container.authority.running) fail("exact container is not running");
  if (
    observeHermesPortableAuthenticatedHealth(qualified.receipt, qualified.containerDeps) !== "ready"
  ) {
    fail("authenticated health is not ready");
  }
  qualify(sandboxName, context, deps, qualified.snapshot);
}

export interface PreparedHermesPortableSandboxRemoval {
  readonly present: boolean;
  readonly receipt: HermesPortableConfiguredReceipt;
  readonly snapshot: HermesPortableReceiptSnapshot;
  readonly removeAndVerify: () => void;
  readonly verifyAbsent: () => void;
}

function classifySandboxAbsence(
  capture: NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]>,
  receipt: HermesPortableConfiguredReceipt,
  sandboxName: string,
): "present" | "absent" | "unknown" {
  const result = capture(
    ["sandbox", "list", "-g", receipt.gatewayName, "-o", "json"],
    COMMAND_TIMEOUT_MS,
  );
  if (result.error) return "unknown";
  return classifyOpenShellSandboxPresence(sandboxName, {
    status: result.status,
    stdout: commandOutput(result.stdout, "sandbox list output"),
    stderr: commandOutput(result.stderr, "sandbox list diagnostic"),
  });
}

function requireNoContainerLookupResult(result: HermesPortablePodmanResult, label: string): void {
  if (result.status !== 0 || result.error) fail(`cannot prove ${label} absence`);
  const values = result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
    fail(`${label} lookup returned malformed identity`);
  }
  if (values.length !== 0) fail(`${label} replacement exists`);
}

function assertHermesPortableContainerAbsent(
  receipt: HermesPortableConfiguredReceipt,
  deps: HermesPortableContainerDeps,
): void {
  (deps.assertSocketAuthority ?? assertPodmanSocketAuthority)(
    receipt.socketAuthority,
    deps.socketAuthority,
  );
  const common = ["ps", "--all", "--no-trunc"] as const;
  requireNoContainerLookupResult(
    deps.podman(
      [...common, "--filter", `id=${receipt.container.containerId}`, "--format", "{{.ID}}"],
      COMMAND_TIMEOUT_MS,
    ),
    "exact container",
  );
  requireNoContainerLookupResult(
    deps.podman(
      [
        ...common,
        "--filter",
        `label=${PODMAN_MANAGED_LABEL}=true`,
        "--filter",
        `label=${PODMAN_SANDBOX_NAME_LABEL}=${receipt.sandboxName}`,
        "--filter",
        `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
        "--format",
        "{{.ID}}",
      ],
      COMMAND_TIMEOUT_MS,
    ),
    "managed same-name container",
  );
  requireNoContainerLookupResult(
    deps.podman(
      [...common, "--filter", `name=^${receipt.container.name}$`, "--format", "{{.ID}}"],
      COMMAND_TIMEOUT_MS,
    ),
    "same-name container",
  );
  (deps.assertSocketAuthority ?? assertPodmanSocketAuthority)(
    receipt.socketAuthority,
    deps.socketAuthority,
  );
}

function requireStaticRegistry(
  receipt: HermesPortableConfiguredReceipt,
  deps: HermesPortableLifecycleDeps,
): void {
  const entry = deps.readRegistry?.(receipt.sandboxName);
  if (
    !entry ||
    entry.name !== receipt.sandboxName ||
    entry.agent !== "hermes" ||
    entry.openshellDriver !== "docker" ||
    entry.gatewayName !== receipt.gatewayName ||
    entry.lifecycleGeneration !== receipt.lifecycleGeneration ||
    entry.openshellVersion !== HERMES_PORTABLE_OPENSHELL_VERSION ||
    typeof entry.lifecycleLiveIdentityFingerprint !== "string"
  ) {
    fail("registry authority disagrees with the active receipt");
  }
}

/** Prepare exact sandbox deletion, admitting absence only after a durable uninstall journal exists. */
export function prepareHermesPortableSandboxRemoval(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: HermesPortableLifecycleDeps = {},
  options: {
    readonly allowAbsent?: boolean;
    readonly expectedReceiptSha256?: string;
  } = {},
): PreparedHermesPortableSandboxRemoval {
  const commandEnv = deps.env ?? process.env;
  assertNoOpenShellGatewayEndpointOverride(commandEnv);
  const stateDir = deps.stateDir ?? defaultPortableDemoStateDir(commandEnv);
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    fail("mutation requires the sandbox lifecycle lock");
  }
  const expectedSnapshot = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
  if (!expectedSnapshot || expectedSnapshot.receipt.phase !== "active") {
    fail("active receipt authority disappeared");
  }
  if (
    options.expectedReceiptSha256 !== undefined &&
    expectedSnapshot.sha256 !== options.expectedReceiptSha256
  ) {
    fail("receipt authority changed");
  }
  const receipt = expectedSnapshot.receipt;
  if (!contextMatches(receipt, context)) fail("registry context disagrees with the active receipt");

  const inspect = (
    admitAbsence = options.allowAbsent === true,
  ): {
    readonly present: boolean;
    readonly qualified?: QualifiedHermesPortableLifecycle;
    readonly capture: NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]>;
    readonly containerDeps: HermesPortableContainerDeps;
  } => {
    const snapshot = readHermesPortableLifecycleReceipt(sandboxName, stateDir);
    if (!snapshot || !sameSnapshot(snapshot, expectedSnapshot)) fail("receipt authority changed");
    assertCurrentHermesPortableStoredStartupContract(receipt.startup, sandboxName);
    assertHermesPortableDurablePolicyAuthority(receipt.policy);
    requireStaticRegistry(receipt, deps);
    const assertExecutable =
      deps.assertOpenShellExecutableAuthority ?? assertHermesPortableOpenShellExecutableAuthority;
    const commandAuthority = buildHermesPortableOpenShellCommandAuthority(
      receipt,
      commandEnv,
      assertExecutable,
    );
    const rawCapture =
      deps.captureOpenShell ??
      defaultCaptureOpenShell(
        commandAuthority.executablePath,
        commandEnv,
        receipt.runtimeAuthority,
      );
    const capture: NonNullable<HermesPortableLifecycleDeps["captureOpenShell"]> = (
      args,
      timeoutMs,
    ) => {
      buildHermesPortableOpenShellCommandAuthority(receipt, commandEnv, assertExecutable);
      return rawCapture(args, timeoutMs);
    };
    const current = capture(
      ["sandbox", "get", "-g", receipt.gatewayName, receipt.sandboxName],
      COMMAND_TIMEOUT_MS,
    );
    const containerDeps =
      typeof deps.container === "function"
        ? deps.container(receipt)
        : (deps.container ?? createContainerDeps(receipt, commandEnv, deps.podmanAuthorityDeps));
    if (current.status !== 0 || current.error) {
      const presence = current.error
        ? "unknown"
        : classifySandboxAbsence(capture, receipt, sandboxName);
      if (presence !== "absent") fail("cannot prove the current OpenShell sandbox");
      if (!admitAbsence) fail("sandbox disappeared before uninstall journal publication");
      assertHermesPortableContainerAbsent(receipt, containerDeps);
      return { present: false, capture, containerDeps };
    }
    const qualified = qualify(sandboxName, context, deps, expectedSnapshot, ["Ready", "Stopped"]);
    return { present: true, qualified, capture, containerDeps: qualified.containerDeps };
  };

  const initial = inspect();
  const verifyAbsent = (): void => {
    const current = inspect(true);
    if (current.present) fail("OpenShell sandbox remained after deletion");
  };
  return Object.freeze({
    present: initial.present,
    receipt,
    snapshot: expectedSnapshot,
    removeAndVerify() {
      const current = inspect();
      if (!current.present) return;
      const removed = current.capture(
        ["sandbox", "delete", "-g", receipt.gatewayName, receipt.sandboxName],
        40_000,
      );
      const after = inspect(true);
      if (after.present) {
        if (removed.status !== 0 || removed.error) fail("exact sandbox deletion failed");
        fail("exact sandbox remained after deletion");
      }
    },
    verifyAbsent,
  });
}

/** Stop only the exact schema-5 full ID after revalidating after the callback. */
export function stopHermesPortableSandboxLifecycle(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  beforeStop: () => void,
  deps: HermesPortableLifecycleDeps = {},
): PortableDemoLifecycleStopResult {
  let qualified = qualify(sandboxName, context, deps);
  if (!qualified.container.authority.running && qualified.container.status === "exited") {
    return { kind: "already-stopped" };
  }
  if (qualified.container.authority.running) beforeStop();
  qualified = qualify(sandboxName, context, deps, qualified.snapshot);
  const result = stopHermesPortableContainer(qualified.receipt, {
    ...qualified.containerDeps,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const final = qualify(sandboxName, context, deps, qualified.snapshot);
  if (final.container.authority.running) fail("exact container remained running after stop");
  return { kind: result };
}

export const hermesPortableLifecycleInternals = {
  buildHermesPortableOpenShellEnv,
  createContainerDeps,
  qualify,
};
