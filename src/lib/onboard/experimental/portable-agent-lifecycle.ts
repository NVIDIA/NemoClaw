// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  recoverHermesPortableSandboxLifecycle,
  stopHermesPortableSandboxLifecycle,
  type HermesPortableLifecycleDeps,
} from "./hermes-portable-lifecycle";
import { inspectPortableAgentReceiptAuthority } from "./hermes-portable-receipt";
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

export const HERMES_PORTABLE_UNSUPPORTED_COMMAND_MESSAGE =
  "This command is not supported for an experimental Hermes portable sandbox.";

export type PortableAgentReceiptDisposition =
  | { readonly kind: "absent" }
  | { readonly kind: "openclaw" }
  | {
      readonly kind: "hermes";
      readonly phase: "pending" | "configuring" | "active";
    };

/** Strictly distinguish absent, schema-4 OpenClaw, and schema-5 Hermes authority. */
export function inspectPortableAgentReceiptDisposition(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
  stateDir = defaultPortableDemoStateDir(env),
): PortableAgentReceiptDisposition {
  const authority = inspectPortableAgentReceiptAuthority(sandboxName, stateDir);
  if (authority.kind === "none") return { kind: "absent" };
  if (authority.kind === "openclaw") return { kind: "openclaw" };
  return { kind: "hermes", phase: authority.snapshot.receipt.phase };
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

/** Route one portable stop without permitting a Docker fallback. */
export function stopPortableAgentSandboxLifecycle(
  sandboxName: string,
  context: PortableDemoLifecycleContext,
  beforeStop: () => void,
  deps: PortableAgentLifecycleDeps = {},
): PortableDemoLifecycleStopResult {
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
  return stopHermesPortableSandboxLifecycle(sandboxName, context, () => undefined, deps);
}
