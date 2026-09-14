// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact, redactFull, redactFullWithUrls, redactSensitiveText } from "../../security/redact";

/** Queue nested errors without cloning them; scalar causes can also carry credentials. */
function redactNestedOnboardError(value: unknown, pending: Error[]): unknown {
  if (typeof value === "string") return redactOnboardErrorText(value);
  if (value instanceof Error) pending.push(value);
  return value;
}

/** Redact causes and aggregate members in place; shared or cyclic links retain their identity. */
export function redactOnboardError(error: Error): void {
  const pending = [error];
  const seen = new WeakSet<Error>();
  // An iterative walk also supports deep cause chains without consuming the call stack.
  for (const current of pending) {
    if (seen.has(current)) continue;
    seen.add(current);
    current.message = redactOnboardErrorText(current.message);
    current.stack = current.stack && redactOnboardErrorText(current.stack);
    if ("cause" in current) current.cause = redactNestedOnboardError(current.cause, pending);
    if (current instanceof AggregateError) {
      for (const [index, member] of current.errors.entries()) {
        current.errors[index] = redactNestedOnboardError(member, pending);
      }
    }
  }
}

/** Redact complete secret blocks before bounding individual diagnostic lines. */
export function redactOnboardErrorText(message: string): string {
  return redactFullWithUrls(message).split("\n").map(redactOnboardDiagnosticText).join("\n");
}

/** Bound a diagnostic after removing recognized credential values. */
export function redactOnboardDiagnosticText(message: string): string {
  return redactSensitiveText(message) ?? "";
}

/** Preserve the command diagnostic's existing redaction and length contract. */
export function redactOnboardCommandDiagnosticText(message: string): string {
  return redactSensitiveText(redact(redactFull(message))) ?? "";
}
