// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifyPolicySetResult } from "./policy-set-outcome";

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

/** gRPC status 9 (FAILED_PRECONDITION): OpenShell understood and refused. */
const SEMANTIC_REJECTION_STDERR =
  "Error: code: 'Failed precondition', message: 'network policy \"team-web\" rejected: " +
  'preset "slack" declares an egress host that conflicts with the sandbox baseline\', ' +
  "source: tonic::Status { code: FailedPrecondition, grpc_status: 9 }";

describe("openshell policy set outcome classification", () => {
  it("reports a clean exit with no error as applied (#9206)", () => {
    expect(classifyPolicySetResult({ status: 0 })).toEqual({ kind: "applied" });
  });

  it("preserves the status and authoritative message of a semantic rejection (#9206)", () => {
    const outcome = classifyPolicySetResult({ status: 1, stderr: SEMANTIC_REJECTION_STDERR });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.status).toBe(1);
    expect(outcome.message).toBe(
      'network policy "team-web" rejected: preset "slack" declares an egress host ' +
        "that conflicts with the sandbox baseline",
    );
  });

  it("treats an HTTP/2 stream reset as ambiguous rather than a refusal (#9206)", () => {
    const outcome = classifyPolicySetResult({ status: 1, stderr: HTTP2_RESET_STDERR });

    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.detail).toContain("h2 protocol error");
    expect(outcome.detail).toContain("Reset(StreamId(3), PROTOCOL_ERROR, Library)");
  });

  it("treats a spawn-level failure with no exit status as ambiguous (#9206)", () => {
    const outcome = classifyPolicySetResult({
      status: null,
      error: { message: "spawnSync openshell ENOENT" },
    });

    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.detail).toContain("ENOENT");
  });

  it("treats a nonzero exit with no diagnostic output as ambiguous (#9206)", () => {
    expect(classifyPolicySetResult({ status: 1, stderr: "" }).kind).toBe("ambiguous");
    expect(classifyPolicySetResult({ status: 1 }).kind).toBe("ambiguous");
    expect(classifyPolicySetResult({ status: 1, stderr: "   \n  " }).kind).toBe("ambiguous");
  });

  it("never reports success for any nonzero or absent exit status (#9206)", () => {
    const statuses: ReadonlyArray<number | null> = [1, 2, 9, 13, 14, 127, null];
    const stderrs: ReadonlyArray<string | null> = [
      SEMANTIC_REJECTION_STDERR,
      HTTP2_RESET_STDERR,
      "",
      null,
      "openshell: connection refused",
    ];

    for (const status of statuses) {
      for (const stderr of stderrs) {
        const outcome = classifyPolicySetResult({ status, stderr });
        expect({ status, stderr, kind: outcome.kind }).toEqual({
          status,
          stderr,
          kind: expect.not.stringMatching(/^applied$/),
        });
      }
    }
  });

  it("treats a clean exit carrying a transport error as ambiguous (#9206)", () => {
    const outcome = classifyPolicySetResult({
      status: 0,
      error: { message: "stream closed before the response completed" },
    });

    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.detail).toContain("stream closed before the response completed");
  });
});
