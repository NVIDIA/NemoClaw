// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getProbeRecovery, getTransportRecoveryMessage } from "./validation-recovery";

describe("validation-recovery helpers", () => {
  it("classifies local curl invocation errors separately from network timeouts", () => {
    expect(getTransportRecoveryMessage({ curlStatus: 2, message: "curl --manual" })).toContain(
      "local curl invocation error",
    );
    expect(getTransportRecoveryMessage({ curlStatus: 28, message: "operation timed out" })).toContain(
      "timed out",
    );
  });

  it("returns targeted transport guidance for DNS and TLS failures", () => {
    expect(getTransportRecoveryMessage({ curlStatus: 6, message: "Could not resolve host" })).toContain(
      "could not resolve",
    );
    expect(getTransportRecoveryMessage({ curlStatus: 60, message: "SSL certificate problem" })).toContain(
      "TLS/certificate",
    );
  });

  it("prefers credential failures over endpoint and model issues", () => {
    expect(
      getProbeRecovery({
        failures: [
          { httpStatus: 404, message: "not found" },
          { httpStatus: 401, message: "invalid api key" },
        ],
      }),
    ).toEqual({ kind: "credential", retry: "credential" });
  });

  it("returns the first transport failure for retry guidance", () => {
    const failure = { curlStatus: 7, message: "failed to connect" };
    expect(getProbeRecovery({ failures: [{ httpStatus: 404 }, failure] })).toEqual({
      kind: "transport",
      retry: "retry",
      failure,
    });
  });

  it("only allows model-specific retry when explicitly enabled", () => {
    const probe = { failures: [{ httpStatus: 400, message: "unknown model" }] };
    expect(getProbeRecovery(probe)).toEqual({ kind: "unknown", retry: "selection" });
    expect(getProbeRecovery(probe, { allowModelRetry: true })).toEqual({
      kind: "model",
      retry: "model",
    });
  });
});
