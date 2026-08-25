// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandboxForQuarantine } from "../../../state/registry/quarantine-operations";
import type { SandboxEntry } from "../../../state/registry/types";

const QUARANTINE_ALLOWED_COMMANDS = new Set([
  "sandbox:channels:list",
  "sandbox:channels:status",
  "sandbox:channels:stop",
  "sandbox:config:get",
  "sandbox:destroy",
  "sandbox:doctor",
  "sandbox:download",
  "sandbox:hosts:list",
  "sandbox:inference:get",
  "sandbox:logs",
  "sandbox:policy:explain",
  "sandbox:policy:get",
  "sandbox:policy:list",
  "sandbox:quarantine",
  "sandbox:quarantine:release",
  "sandbox:sessions:export",
  "sandbox:sessions:list",
  "sandbox:share:status",
  "sandbox:shields:down",
  "sandbox:shields:status",
  "sandbox:snapshot:create",
  "sandbox:snapshot:list",
  "sandbox:status",
  "sandbox:stop",
]);

export class SandboxQuarantineError extends Error {
  constructor(
    readonly sandboxName: string,
    readonly fenceId: string,
    readonly phase: string,
    action: string,
  ) {
    super(
      `Sandbox '${sandboxName}' is quarantined (${phase}, fence ${fenceId}); ` +
        `'${action}' cannot reactivate or mutate it. Inspect status or evidence, destroy it, ` +
        `or run 'quarantine release --fence-id ${fenceId}' for sandbox '${sandboxName}'.`,
    );
    this.name = "SandboxQuarantineError";
  }
}

export function assertSandboxActivationAllowed(
  sandboxName: string,
  action: string,
  getSandbox: (name: string) => SandboxEntry | null = getSandboxForQuarantine,
): void {
  const fence = getSandbox(sandboxName)?.quarantine;
  if (!fence) return;
  throw new SandboxQuarantineError(sandboxName, fence.fenceId, fence.phase, action);
}

/** Fail closed for mutating sandbox commands while preserving status/evidence and destroy. */
export function assertSandboxCommandAllowedByQuarantine(
  commandId: string,
  sandboxName: string,
  argv: readonly string[],
  getSandbox: (name: string) => SandboxEntry | null = getSandboxForQuarantine,
): void {
  if (QUARANTINE_ALLOWED_COMMANDS.has(commandId)) {
    if (commandId !== "sandbox:doctor" || !argv.includes("--fix")) return;
  }
  assertSandboxActivationAllowed(sandboxName, commandId, getSandbox);
}
