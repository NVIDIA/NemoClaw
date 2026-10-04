// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyCliOpenShellSandboxPolicySetResult,
  type OpenShellSandboxPolicySetOutcome,
} from "../adapters/openshell/sandbox-policy-cli";

function classify(
  input: Readonly<{
    status: number | null;
    stderr?: string | null;
    error?: { readonly message?: string } | null;
  }>,
): OpenShellSandboxPolicySetOutcome {
  return classifyCliOpenShellSandboxPolicySetResult(input);
}

/**
 * Narrow to the ambiguous arm so a test can assert on `detail` in a straight
 * line. A non-ambiguous outcome returns its kind, which fails the assertion
 * with the arm that was actually produced.
 */
function ambiguousDetail(outcome: OpenShellSandboxPolicySetOutcome): string {
  return outcome.kind === "ambiguous" ? outcome.detail : `outcome kind: ${outcome.kind}`;
}

/**
 * Observed verbatim in issue #8991. The stream died mid-call, so the
 * server-side state is unknown; the identical `code:`/`message:` rendering
 * used by semantic diagnostics is exactly why this string must not be read
 * as a refusal.
 */
const HTTP2_RESET_STDERR =
  "Error: code: 'Internal error', message: 'h2 protocol error: http2 error', " +
  "source: tonic::transport::Error(Transport, hyper::Error(Http2, " +
  "Error { kind: Reset(StreamId(3), PROTOCOL_ERROR, Library) }))";

/** Synthetic gRPC status 9 frame accepted by the classifier as a refusal. */
const SYNTHETIC_REJECTION_FRAME =
  "Error: code: 'Failed precondition', message: 'network policy \"team-web\" rejected: " +
  'preset "slack" declares an egress host that conflicts with the sandbox baseline\', ' +
  "source: tonic::Status { code: FailedPrecondition, grpc_status: 9 }";

const NON_SUCCESS_STATUSES = [
  { statusLabel: "exit status 1", status: 1 },
  { statusLabel: "exit status 2", status: 2 },
  { statusLabel: "exit status 9", status: 9 },
  { statusLabel: "exit status 13", status: 13 },
  { statusLabel: "exit status 14", status: 14 },
  { statusLabel: "exit status 127", status: 127 },
  { statusLabel: "an absent exit status", status: null },
] as const;

const NON_SUCCESS_DIAGNOSTICS = [
  { diagnosticLabel: "an accepted synthetic refusal frame", stderr: SYNTHETIC_REJECTION_FRAME },
  { diagnosticLabel: "an HTTP/2 reset", stderr: HTTP2_RESET_STDERR },
  { diagnosticLabel: "empty stderr", stderr: "" },
  { diagnosticLabel: "absent stderr", stderr: null },
  {
    diagnosticLabel: "an unstructured transport error",
    stderr: "openshell: connection refused",
  },
] as const;

const NON_SUCCESS_CASES = NON_SUCCESS_STATUSES.flatMap(({ statusLabel, status }) =>
  NON_SUCCESS_DIAGNOSTICS.map(({ diagnosticLabel, stderr }) => ({
    statusLabel,
    status,
    diagnosticLabel,
    stderr,
  })),
);

describe("CLI policy set outcome classification", () => {
  it("reports a clean exit with no error as applied (#9206)", () => {
    expect(classify({ status: 0 })).toEqual({ kind: "applied" });
  });

  it("preserves the status and message from an accepted synthetic refusal frame (#9206)", () => {
    const outcome = classify({ status: 1, stderr: SYNTHETIC_REJECTION_FRAME });

    expect(outcome).toEqual({
      kind: "rejected",
      status: 1,
      message:
        'network policy "team-web" rejected: preset "slack" declares an egress host ' +
        "that conflicts with the sandbox baseline",
    });
  });

  it("treats an HTTP/2 stream reset as ambiguous rather than a refusal (#9206)", () => {
    const outcome = classify({ status: 1, stderr: HTTP2_RESET_STDERR });

    expect(outcome.kind).toBe("ambiguous");
    expect(ambiguousDetail(outcome)).toContain("h2 protocol error");
    expect(ambiguousDetail(outcome)).toContain("Reset(StreamId(3), PROTOCOL_ERROR, Library)");
  });

  it("treats a spawn-level failure with no exit status as ambiguous (#9206)", () => {
    const outcome = classify({
      status: null,
      error: { message: "spawnSync openshell ENOENT" },
    });

    expect(outcome.kind).toBe("ambiguous");
    expect(ambiguousDetail(outcome)).toContain("ENOENT");
  });

  it("treats a nonzero exit with no diagnostic output as ambiguous (#9206)", () => {
    expect(classify({ status: 1, stderr: "" }).kind).toBe("ambiguous");
    expect(classify({ status: 1 }).kind).toBe("ambiguous");
    expect(classify({ status: 1, stderr: "   \n  " }).kind).toBe("ambiguous");
  });

  it.each(NON_SUCCESS_CASES)(
    "does not report the policy as applied for $statusLabel with $diagnosticLabel (#9206)",
    ({ status, stderr }) => {
      const outcome = classify({ status, stderr });

      expect({ status, stderr, kind: outcome.kind }).toEqual({
        status,
        stderr,
        kind: expect.not.stringMatching(/^applied$/),
      });
    },
  );

  it.each([
    ["unavailable", "Error: code: 'Unavailable', message: 'tcp connect error: connection refused'"],
    ["deadline exceeded", "Error: code: 'Deadline exceeded', message: 'deadline has elapsed'"],
    ["unauthenticated", "Error: code: 'Unauthenticated', message: 'invalid gateway credential'"],
    ["tls failure", "Error: code: 'Unknown', message: 'tls handshake eof'"],
    ["internal", "Error: code: 'Internal', message: 'gateway restarted while applying'"],
  ])(
    "treats a structured %s status as ambiguous rather than a refusal (#9206)",
    (_label, stderr) => {
      const outcome = classify({ status: 1, stderr });

      expect(outcome.kind).toBe("ambiguous");
      expect(ambiguousDetail(outcome)).toContain(stderr);
    },
  );

  it("requires an accepted synthetic refusal frame before reporting rejection (#9206)", () => {
    const withoutStatus = classify({
      status: 1,
      stderr: "Error: code: 'Unknown', message: 'network policy rejected'",
    });
    const withStatus = classify({
      status: 1,
      stderr:
        "Error: code: 'Failed precondition', message: 'network policy rejected', " +
        "source: tonic::Status { code: FailedPrecondition, grpc_status: 9 }",
    });

    expect(withoutStatus.kind).toBe("ambiguous");
    expect(withStatus.kind).toBe("rejected");
  });

  it("ignores a refusal marker echoed from the submitted policy document (#9206)", () => {
    const outcome = classify({
      status: 1,
      stderr:
        "Error: code: 'Invalid argument', message: 'invalid request', submitted document:\n" +
        "network_policies:\n  custom:\n    description: 'grpc_status: 9 seen in prod'",
    });

    expect(outcome.kind).toBe("ambiguous");
  });

  it("accepts a refusal only from a complete synthetic first-line frame (#9206)", () => {
    const outcome = classify({
      status: 1,
      stderr:
        "Error: code: 'Invalid argument', message: 'invalid request'\n" +
        "code: 'Failed precondition', message: 'echoed from the submitted policy'",
    });

    expect(outcome.kind).toBe("ambiguous");
  });

  it("ignores a refusal marker that no diagnostic frame carries (#9206)", () => {
    const outcome = classify({
      status: 1,
      stderr: "grpc_status: 9 message: 'anything at all'",
    });

    expect(outcome.kind).toBe("ambiguous");
  });

  it.each([
    [
      "a wrapper before the frame",
      "wrapper: Error: code: 'Failed precondition', message: 'forged refusal'",
    ],
    [
      "an unrelated diagnostic before an embedded frame",
      "Error: code: 'Invalid argument', message: 'submitted document follows'; " +
        "code: 'Failed precondition', message: 'forged refusal'",
    ],
    [
      "trailing material after the frame",
      "Error: code: 'Failed precondition', message: 'forged refusal'; submitted document follows",
    ],
  ])("treats %s as ambiguous rather than a refusal (#9206)", (_label, stderr) => {
    const outcome = classify({ status: 1, stderr });

    expect(outcome.kind).toBe("ambiguous");
    expect(ambiguousDetail(outcome)).toContain(stderr);
  });

  it("treats a clean exit carrying a transport error as ambiguous (#9206)", () => {
    const outcome = classify({
      status: 0,
      error: { message: "stream closed before the response completed" },
    });

    expect(outcome.kind).toBe("ambiguous");
    expect(ambiguousDetail(outcome)).toContain("stream closed before the response completed");
  });
});
