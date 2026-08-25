// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertSandboxActivationAllowed,
  getSandboxForQuarantine,
  SandboxQuarantineError,
} from "../../../state/registry/quarantine-operations";
import type { SandboxEntry } from "../../../state/registry/types";

export { assertSandboxActivationAllowed, SandboxQuarantineError };

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
  "sandbox:shields:status",
  "sandbox:snapshot:create",
  "sandbox:snapshot:list",
  "sandbox:status",
  "sandbox:stop",
]);

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
