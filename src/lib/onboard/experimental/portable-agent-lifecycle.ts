// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import { isMcpLifecycleLockHeld } from "../../state/mcp-lifecycle-lock-acquisition";
import type { SandboxEntry } from "../../state/registry/types";
import {
  assertHermesPortableSandboxLifecycleAuthority,
  buildHermesPortableOpenShellCommandAuthority,
  buildHermesPortableOpenShellEnv,
  recoverHermesPortableSandboxLifecycle,
  requalifyHermesPortableSandboxAuthority,
  stopHermesPortableSandboxLifecycle,
  type HermesPortableLifecycleDeps,
} from "./hermes-portable-lifecycle";
import {
  inspectPortableAgentReceiptAuthority,
  inspectPortableAgentReceiptAuthorityForClassification,
  inspectPortableAgentReceiptAuthorityForRequalification,
  type PortableAgentReceiptAuthority,
} from "./hermes-portable-receipt";
import { qualifyHermesPortableOperatingAuthority } from "./hermes-portable-operating-authority";
import {
  recoverPortableDemoSandboxLifecycle,
  stopPortableDemoSandboxLifecycle,
  type PortableDemoLifecycleContext,
  type PortableDemoLifecycleDeps,
  type PortableDemoLifecycleRecoveryResult,
  type PortableDemoLifecycleStopResult,
} from "./portable-demo-lifecycle";
import { defaultPortableDemoStateDir } from "./portable-runtime-receipt-readiness";

export type PortableAgentLifecycleDeps = PortableDemoLifecycleDeps & HermesPortableLifecycleDeps;
export type PortableAgentLifecycleStopResult = PortableDemoLifecycleStopResult & {
  readonly portableAgent?: "hermes";
};

export const HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE =
  "This command is not supported for an experimental Hermes portable sandbox.";
export const HERMES_PORTABLE_UNSUPPORTED_DOCTOR_FIX_MESSAGE =
  "The --fix option is not supported for an experimental Hermes portable sandbox.";

const HERMES_PORTABLE_COMMANDS = new Set([
  "launch",
  "sandbox:connect",
  "sandbox:doctor",
  "sandbox:recover",
  "sandbox:start",
  "sandbox:status",
  "sandbox:stop",
]);

const RAW_SANDBOX_NAME_COMMANDS = new Set([
  "sandbox:agent",
  "sandbox:agents",
  "sandbox:agents:add",
  "sandbox:agents:apply",
  "sandbox:agents:delete",
  "sandbox:agents:list",
  "sandbox:mcp",
  "sandbox:sessions",
  "sandbox:sessions:list",
  "sandbox:skill",
]);

const MULTI_SANDBOX_LIFECYCLE_COMMANDS = new Set(["sandbox:snapshot:restore"]);

const SANDBOX_COMMANDS_WITH_INTERNAL_LIFECYCLE_FENCE = new Set([
  "sandbox:shields:down",
  "sandbox:shields:status",
  "sandbox:shields:up",
]);

const HERMES_PORTABLE_UNSUPPORTED_HOST_EFFECTS = new Set([
  "debug",
  "inference:get",
  "list",
  "stop",
  "tunnel:start",
  "tunnel:stop",
  "upgrade-sandboxes",
  "use",
]);

const HERMES_PORTABLE_HOST_FENCED_READS = new Set(["status"]);

export type HermesPortableCommandPolicy = {
  readonly helpRequested: boolean;
  readonly hostFence: "read" | "deny" | null;
  readonly multiSandboxLifecycle: boolean;
  readonly ownsLifecycleFence: boolean;
  readonly rawSandboxName: boolean;
};

/** Classify one CLI invocation without treating payload arguments as host help. */
export function classifyHermesPortableCommand(
  commandId: string,
  argv: readonly string[],
): HermesPortableCommandPolicy {
  const separator = argv.indexOf("--");
  const hostArgv = separator === -1 ? argv : argv.slice(0, separator);
  return {
    helpRequested: hostArgv.includes("--help") || hostArgv.includes("-h"),
    hostFence: HERMES_PORTABLE_HOST_FENCED_READS.has(commandId)
      ? "read"
      : HERMES_PORTABLE_UNSUPPORTED_HOST_EFFECTS.has(commandId)
        ? "deny"
        : null,
    multiSandboxLifecycle: MULTI_SANDBOX_LIFECYCLE_COMMANDS.has(commandId),
    ownsLifecycleFence: SANDBOX_COMMANDS_WITH_INTERNAL_LIFECYCLE_FENCE.has(commandId),
    rawSandboxName: RAW_SANDBOX_NAME_COMMANDS.has(commandId),
  };
}

/** Reject one unsupported command while Hermes receipt authority exists. */
export function assertHermesPortableCommandSupported(
  commandId: string,
  sandboxName: string,
  argv: readonly string[],
): void {
  const separator = argv.indexOf("--");
  const hostArgv = separator === -1 ? argv : argv.slice(0, separator);
  const doctorFix = commandId === "sandbox:doctor" && hostArgv.includes("--fix");
  const supported = HERMES_PORTABLE_COMMANDS.has(commandId) && !doctorFix;
  if (supported) return;
  const authority = inspectPortableAgentReceiptAuthorityForClassification(
    sandboxName,
    defaultPortableDemoStateDir(process.env),
  );
  if (authority.kind !== "hermes") return;
  if (doctorFix) {
    throw new Error(`${HERMES_PORTABLE_UNSUPPORTED_DOCTOR_FIX_MESSAGE} Command: ${commandId}`);
  }
  throw new Error(`${HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE} Command: ${commandId}`);
}

export type PortableAgentReceiptDisposition =
  | { readonly kind: "absent" }
  | { readonly kind: "openclaw" }
  | {
      readonly kind: "hermes";
      readonly phase: "pending" | "configuring" | "active";
      readonly gatewayName: string;
      readonly lifecycleGeneration: string;
      readonly liveIdentityFingerprint: string | null;
    };

export type HermesPortableAgentLifecycleAuthority = Extract<
  PortableAgentReceiptDisposition,
  { readonly kind: "hermes" }
> & {
  readonly entry: SandboxEntry | null;
};

export type PortableAgentLifecycleAuthority =
  | Exclude<PortableAgentReceiptDisposition, { readonly kind: "hermes" }>
  | HermesPortableAgentLifecycleAuthority;

export type HermesPortableActiveLifecycleAuthority = Omit<
  HermesPortableAgentLifecycleAuthority,
  "entry" | "phase"
> & {
  readonly phase: "active";
  readonly entry: SandboxEntry;
};

export interface PortableAgentLifecycleAuthorityDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDir?: string;
  readonly inspectReceiptDisposition?: (sandboxName: string) => PortableAgentReceiptDisposition;
  readonly readRegistry: (sandboxName: string) => SandboxEntry | null;
}

function receiptDisposition(
  authority: PortableAgentReceiptAuthority,
): PortableAgentReceiptDisposition {
  if (authority.kind === "none") return { kind: "absent" };
  if (authority.kind === "openclaw") return { kind: "openclaw" };
  const { receipt } = authority.snapshot;
  return {
    kind: "hermes",
    phase: receipt.phase,
    gatewayName: receipt.gatewayName,
    lifecycleGeneration: receipt.lifecycleGeneration,
    liveIdentityFingerprint:
      receipt.phase === "pending"
        ? null
        : createHash("sha256").update(receipt.container.sandboxId).digest("hex"),
  };
}

/** Strictly distinguish absent, OpenClaw, and Hermes receipt authority. */
export function inspectPortableAgentReceiptDisposition(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultPortableDemoStateDir(env),
): PortableAgentReceiptDisposition {
  return receiptDisposition(
    inspectPortableAgentReceiptAuthorityForClassification(sandboxName, stateDir),
  );
}

/** Classify copied Hermes authority while the probe owns its lifecycle fence. */
function inspectPortableAgentReceiptDispositionForRequalification(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultPortableDemoStateDir(env),
): PortableAgentReceiptDisposition {
  return receiptDisposition(
    inspectPortableAgentReceiptAuthorityForRequalification(sandboxName, stateDir),
  );
}

/** Requalify only Hermes authority while the probe owns both Portable fences. */
export function requalifyPortableAgentSandboxAuthority(
  sandboxName: string,
  deps: PortableAgentLifecycleDeps & PortableAgentLifecycleAuthorityDeps,
) {
  const authority = qualifyPortableAgentLifecycleAuthority(sandboxName, {
    ...deps,
    inspectReceiptDisposition:
      deps.inspectReceiptDisposition ??
      ((name) =>
        inspectPortableAgentReceiptDispositionForRequalification(
          name,
          deps.env ?? process.env,
          deps.stateDir,
        )),
  });
  if (authority.kind !== "hermes") return { kind: "not-hermes" as const };
  if (authority.phase !== "active" || !authority.entry) {
    throw new Error("Hermes portable lifecycle authority is missing or incomplete.");
  }
  return requalifyHermesPortableSandboxAuthority(
    sandboxName,
    {
      agent: "hermes",
      gatewayName: authority.gatewayName,
      lifecycleGeneration: authority.lifecycleGeneration,
      openshellDriver: "docker",
      provider: authority.entry.provider,
    },
    deps,
  );
}

/** Classify receipt authority and enforce the Hermes registry invariant. */
export function qualifyPortableAgentLifecycleAuthority(
  sandboxName: string,
  deps: PortableAgentLifecycleAuthorityDeps,
): PortableAgentLifecycleAuthority {
  const disposition = deps.inspectReceiptDisposition
    ? deps.inspectReceiptDisposition(sandboxName)
    : inspectPortableAgentReceiptDisposition(sandboxName, deps.env ?? process.env, deps.stateDir);
  if (disposition.kind !== "hermes") return disposition;

  if (!deps.readRegistry) {
    throw new Error("Hermes portable registry authority reader is required.");
  }
  const entry = deps.readRegistry(sandboxName);
  if (!entry) {
    if (disposition.phase !== "active") return { ...disposition, entry: null };
    throw new Error("Hermes portable active receipt is missing its registry authority.");
  }
  if (
    entry.name !== sandboxName ||
    entry.agent !== "hermes" ||
    entry.openshellDriver !== "docker" ||
    entry.gatewayName !== disposition.gatewayName ||
    entry.lifecycleGeneration !== disposition.lifecycleGeneration ||
    (disposition.phase !== "pending" &&
      entry.lifecycleLiveIdentityFingerprint !== disposition.liveIdentityFingerprint)
  ) {
    throw new Error("Hermes portable receipt and registry authority disagree.");
  }
  if (disposition.phase === "pending") {
    throw new Error("Hermes portable pending receipt conflicts with an existing registry entry.");
  }
  return { ...disposition, entry };
}

/** Require active Hermes receipt and exact registry authority. */
export function requireHermesPortableActiveLifecycleAuthority(
  sandboxName: string,
  expected: HermesPortableActiveLifecycleAuthority | undefined,
  deps: PortableAgentLifecycleAuthorityDeps,
): HermesPortableActiveLifecycleAuthority {
  const current = qualifyPortableAgentLifecycleAuthority(sandboxName, deps);
  if (current.kind !== "hermes" || current.phase !== "active" || !current.entry) {
    throw new Error("Hermes portable lifecycle authority is missing or incomplete.");
  }
  if (
    expected &&
    (current.gatewayName !== expected.gatewayName ||
      current.lifecycleGeneration !== expected.lifecycleGeneration ||
      current.liveIdentityFingerprint !== expected.liveIdentityFingerprint)
  ) {
    throw new Error("Hermes portable lifecycle authority changed during verification.");
  }
  return current as HermesPortableActiveLifecycleAuthority;
}

/** Build a child environment from the exact active Hermes runtime authority. */
export function buildHermesPortableCommandEnvironment(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultPortableDemoStateDir(env),
): NodeJS.ProcessEnv {
  const authority = inspectPortableAgentReceiptAuthority(sandboxName, stateDir);
  if (authority.kind !== "hermes" || authority.snapshot.receipt.phase !== "active") {
    throw new Error("Hermes portable lifecycle authority is missing or incomplete");
  }
  return buildHermesPortableOpenShellEnv(env, authority.snapshot.receipt.runtimeAuthority);
}

/** Requalify the exact executable and environment for one direct Hermes child. */
function inspectHermesPortableCommandAuthority(sandboxName: string, stateDir: string) {
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    throw new Error("Hermes portable command authority requires the sandbox lifecycle lock");
  }
  const classified = inspectPortableAgentReceiptAuthorityForClassification(sandboxName, stateDir);
  let authority: ReturnType<typeof inspectPortableAgentReceiptAuthority>;
  try {
    authority = inspectPortableAgentReceiptAuthority(sandboxName, stateDir);
  } catch (error) {
    if (
      classified.kind === "hermes" &&
      classified.snapshot.receipt.phase === "active" &&
      classified.snapshot.successor === undefined
    ) {
      throw new Error(
        `Hermes portable authority requires 'nemoclaw ${sandboxName} connect --probe-only' before launch.`,
        { cause: error },
      );
    }
    throw error;
  }
  return authority;
}

function qualifyOperatingCommandAuthority(
  authority: Extract<ReturnType<typeof inspectPortableAgentReceiptAuthority>, { kind: "hermes" }>,
  env: NodeJS.ProcessEnv,
) {
  if (!authority.snapshot.successor || authority.snapshot.receipt.phase !== "active") {
    throw new Error("Hermes portable operating command authority is missing or incomplete");
  }
  const operatingAuthority = qualifyHermesPortableOperatingAuthority(
    authority.snapshot as typeof authority.snapshot & {
      readonly receipt: { readonly phase: "active" };
    },
  );
  const commandAuthority = buildHermesPortableOpenShellCommandAuthority(
    operatingAuthority.receipt,
    env,
  );
  operatingAuthority.assertCurrent();
  return { ...commandAuthority, assertCurrent: operatingAuthority.assertCurrent };
}

export function buildHermesPortableCommandAuthority(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultPortableDemoStateDir(env),
) {
  const authority = inspectHermesPortableCommandAuthority(sandboxName, stateDir);
  if (authority.kind !== "hermes" || authority.snapshot.receipt.phase === "pending") {
    throw new Error("Hermes portable lifecycle authority is missing or incomplete");
  }
  if (!authority.snapshot.successor) {
    return buildHermesPortableOpenShellCommandAuthority(authority.snapshot.receipt, env);
  }
  if (authority.snapshot.receipt.phase !== "active") {
    throw new Error("Hermes portable operating authority requires an active receipt");
  }
  const qualified = qualifyOperatingCommandAuthority(authority, env);
  return { env: qualified.env, executablePath: qualified.executablePath };
}

/** Retain one schema-6 command generation and its operation-local currentness fence. */
export function qualifyHermesPortableOperatingCommandAuthority(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultPortableDemoStateDir(env),
) {
  const authority = inspectHermesPortableCommandAuthority(sandboxName, stateDir);
  if (authority.kind !== "hermes") {
    throw new Error("Hermes portable operating command authority is missing or incomplete");
  }
  return qualifyOperatingCommandAuthority(authority, env);
}

/** Requalify a pending/configuring receipt only for its schema-5 onboarding child. */
export function buildHermesPortableOnboardingCommandAuthority(
  sandboxName: string,
  gatewayName: string,
  lifecycleGeneration: string,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultPortableDemoStateDir(env),
) {
  if (!isMcpLifecycleLockHeld(sandboxName, path.join(stateDir, "state"))) {
    throw new Error("Hermes portable onboarding command authority requires the lifecycle lock");
  }
  const authority = inspectPortableAgentReceiptAuthority(sandboxName, stateDir);
  const receipt = authority.kind === "hermes" ? authority.snapshot.receipt : null;
  if (
    !receipt ||
    receipt.phase === "active" ||
    receipt.gatewayName !== gatewayName ||
    receipt.lifecycleGeneration !== lifecycleGeneration
  ) {
    throw new Error("Hermes portable onboarding command authority is missing or disagrees");
  }
  return buildHermesPortableOpenShellCommandAuthority(receipt, env);
}

/** Whether recognized portable authority must bypass Docker preflight. */
export function hasPortableAgentSandboxLifecycleReceipt(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return inspectPortableAgentReceiptDisposition(sandboxName, env).kind !== "absent";
}

/** Reject an unimplemented command from inside its existing sandbox lifecycle fence. */
export function assertHermesPortableCommandUnavailable(
  sandboxName: string,
  commandId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (inspectPortableAgentReceiptDisposition(sandboxName, env).kind !== "hermes") return;
  throw new Error(`${HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE} Command: ${commandId}`);
}

function requireMatchingAgent(
  disposition: Exclude<PortableAgentReceiptDisposition, { readonly kind: "absent" }>,
  context: PortableDemoLifecycleContext,
): void {
  const registryAgent = context.agent ?? "openclaw";
  if (disposition.kind !== registryAgent) {
    throw new Error(
      `Portable lifecycle receipt agent '${disposition.kind}' does not match registry agent '${registryAgent}'`,
    );
  }
}

/** Route one portable start/recovery without permitting a Docker fallback. */
export function recoverPortableAgentSandboxLifecycle(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: PortableAgentLifecycleDeps = {},
): PortableDemoLifecycleRecoveryResult {
  const disposition = inspectPortableAgentReceiptDisposition(
    sandboxName,
    deps.env ?? process.env,
    deps.stateDir,
  );
  if (disposition.kind === "absent") return { kind: "not-installed" };
  requireMatchingAgent(disposition, context);
  if (disposition.kind === "openclaw") {
    return recoverPortableDemoSandboxLifecycle(sandboxName, context, deps);
  }
  if (disposition.phase !== "active") {
    throw new Error(
      `Hermes portable lifecycle receipt phase '${disposition.phase}' is incomplete; resume onboarding before running lifecycle commands`,
    );
  }
  return recoverHermesPortableSandboxLifecycle(sandboxName, context, deps);
}

/** Requalify Hermes authority without permitting lifecycle recovery or fallback. */
export function assertHermesPortableAgentLifecycleAuthority(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  deps: PortableAgentLifecycleDeps = {},
): void {
  const disposition = inspectPortableAgentReceiptDisposition(
    sandboxName,
    deps.env ?? process.env,
    deps.stateDir,
  );
  if (disposition.kind !== "hermes" || disposition.phase !== "active") {
    throw new Error("Hermes portable lifecycle authority is missing or incomplete");
  }
  requireMatchingAgent(disposition, context);
  assertHermesPortableSandboxLifecycleAuthority(sandboxName, context, deps);
}

/** Route one portable stop without permitting a Docker fallback. */
export function stopPortableAgentSandboxLifecycle(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  beforeStop: () => void,
  deps: PortableAgentLifecycleDeps = {},
): PortableAgentLifecycleStopResult {
  const disposition = inspectPortableAgentReceiptDisposition(
    sandboxName,
    deps.env ?? process.env,
    deps.stateDir,
  );
  if (disposition.kind === "absent") return { kind: "not-installed" };
  requireMatchingAgent(disposition, context);
  if (disposition.kind === "openclaw") {
    return stopPortableDemoSandboxLifecycle(sandboxName, context, beforeStop, deps);
  }
  if (disposition.phase !== "active") {
    throw new Error(
      `Hermes portable lifecycle receipt phase '${disposition.phase}' is incomplete; resume onboarding before running lifecycle commands`,
    );
  }
  // Schema-5 owns only the exact Podman container. The Docker provider's
  // channel hook can select Docker transport, so it is never part of Hermes
  // portable stop authority.
  return {
    ...stopHermesPortableSandboxLifecycle(sandboxName, context, () => undefined, deps),
    portableAgent: "hermes",
  };
}
