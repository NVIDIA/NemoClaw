// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

// Import from compiled dist for parity with the other CLI tests in this project.
import { probeSandboxInferenceGatewayHealth } from "../../../../dist/lib/actions/sandbox/process-recovery";

describe("probeSandboxInferenceGatewayHealth — #3265 gateway-chain subprobe", () => {
  const makeExec = (stdout: string, status = 0) =>
    async () => ({ status, stdout, stderr: "" });

  it("reports healthy on any HTTP response (including 401) because the routing chain is up", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: makeExec("200"),
    });
    expect(result?.ok).toBe(true);
    expect(result?.httpStatus).toBe(200);
    expect(result?.endpoint).toBe("https://inference.local/v1/models");
    expect(result?.detail).toContain("HTTP 200");
    expect(result?.detail).toContain("full chain reachable");
  });

  it("treats 401 as routing-OK (auth wall reached means the chain works)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: makeExec("401"),
    });
    expect(result?.ok).toBe(true);
    expect(result?.httpStatus).toBe(401);
  });

  it("reports unreachable when curl returns 000 (DNS or connection refused)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: makeExec("000"),
    });
    expect(result?.ok).toBe(false);
    expect(result?.httpStatus).toBe(0);
    expect(result?.detail).toContain("unreachable");
    expect(result?.detail).toContain("https://inference.local/v1/models");
  });

  it("returns null when the sandbox exec itself fails (probe unavailable, omit the line)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: async () => null,
    });
    expect(result).toBeNull();
  });

  it("returns null when exec returns a non-zero status (sandbox unreachable or stopped)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      execImpl: makeExec("000", 127),
    });
    expect(result).toBeNull();
  });
});
