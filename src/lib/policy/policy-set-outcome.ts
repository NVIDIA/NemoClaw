// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Classification of a single `openshell policy set --wait` invocation.
 *
 * `rejected` asserts finality: OpenShell understood the request and refused
 * it, so resubmitting only replays a policy it already declined. `ambiguous`
 * asserts nothing about server-side state and obliges the caller to read the
 * policy back before deciding anything.
 */
export type PolicySetOutcome =
  | { kind: "applied" }
  | { kind: "rejected"; status: number; message: string }
  | { kind: "ambiguous"; detail: string };

/**
 * Substrings that identify a torn stream rather than a verdict. Every marker
 * is present in the failure observed in issue #8991; a transport failure
 * renders the same `code:`/`message:` shape as a semantic diagnostic, so it
 * must be recognised before the message is read as authoritative.
 */
const TRANSPORT_FAILURE_MARKERS: ReadonlyArray<string> = [
  "h2 protocol error",
  "http2 error",
  "tonic::transport::error",
];

/** OpenShell renders the authoritative diagnostic as `message: '...'`. */
const AUTHORITATIVE_MESSAGE_PATTERN = /message:\s*'([^']*)'/;

function isTransportFailure(detail: string): boolean {
  const haystack = detail.toLowerCase();
  return TRANSPORT_FAILURE_MARKERS.some((marker) => haystack.includes(marker));
}

function combineDetail(
  error: { message?: string } | null | undefined,
  stderr: string | null | undefined,
): string {
  return [error?.message, stderr]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
}

function authoritativeMessage(stderr: string | null | undefined): string | null {
  const matched = stderr?.match(AUTHORITATIVE_MESSAGE_PATTERN)?.[1]?.trim();
  return matched ? matched : null;
}

/**
 * Classify the result of `openshell policy set`. Pure: it inspects only the
 * values handed to it.
 *
 * Uncertainty resolves to `ambiguous`, which costs a readback. Reporting a
 * refusal we cannot evidence, or success we cannot prove, is not recoverable,
 * so a nonzero or absent status never yields `applied`.
 */
export function classifyPolicySetResult(input: {
  status: number | null;
  error?: { message?: string } | null;
  stderr?: string | null;
}): PolicySetOutcome {
  const detail = combineDetail(input.error, input.stderr);
  const ambiguous = (): PolicySetOutcome => ({
    kind: "ambiguous",
    detail: detail || `openshell policy set exited with status ${String(input.status)}`,
  });

  // A torn stream leaves the server-side state unknown whatever else is set.
  if (isTransportFailure(detail)) return ambiguous();

  if (input.status === 0) {
    // A clean exit alongside a transport error is not proof of application.
    return input.error ? ambiguous() : { kind: "applied" };
  }

  // `spawnSync` reports ENOENT and timeouts as a null status: the command may
  // never have run, or may have run and lost its result.
  if (input.status === null) return ambiguous();

  const message = authoritativeMessage(input.stderr);
  return message === null ? ambiguous() : { kind: "rejected", status: input.status, message };
}
