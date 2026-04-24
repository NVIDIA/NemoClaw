// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { verifyDashboardChain } from "../../dist/lib/dashboard-health";
import { buildChain } from "../../dist/lib/dashboard-contract";

const chain = buildChain();

function deps(overrides = {}) {
  return {
    executeSandboxCommand: () => ({ status: 0, stdout: "200" }),
    captureForwardList: () => "my-sandbox  127.0.0.1  18789  12345  running",
    downloadSandboxConfig: () => ({ gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } } }),
    ...overrides,
  };
}

describe("verifyDashboardChain", () => {
  it("reports healthy when all links ok", () => {
    const r = verifyDashboardChain("my-sandbox", chain, deps());
    expect(r.healthy).toBe(true);
  });

  it("treats 401 as alive (fixes #2342)", () => {
    expect(verifyDashboardChain("my-sandbox", chain, deps({ executeSandboxCommand: () => ({ status: 0, stdout: "401" }) })).links.gateway.ok).toBe(true);
  });

  it("reports gateway down on 000 or null", () => {
    expect(verifyDashboardChain("my-sandbox", chain, deps({ executeSandboxCommand: () => ({ status: 0, stdout: "000" }) })).links.gateway.ok).toBe(false);
    expect(verifyDashboardChain("my-sandbox", chain, deps({ executeSandboxCommand: () => null })).links.gateway.ok).toBe(false);
  });

  it("reports forward missing or conflicting", () => {
    expect(verifyDashboardChain("my-sandbox", chain, deps({ captureForwardList: () => null })).links.forward.ok).toBe(false);
    expect(verifyDashboardChain("my-sandbox", chain, deps({ captureForwardList: () => "other  127.0.0.1  18789  1  running" })).links.forward.detail).toContain("other");
  });

  it("reports CORS issues", () => {
    expect(verifyDashboardChain("my-sandbox", chain, deps({ downloadSandboxConfig: () => null })).links.cors.ok).toBe(false);
    expect(verifyDashboardChain("my-sandbox", chain, deps({ downloadSandboxConfig: () => ({ gateway: { controlUi: { allowedOrigins: [] } } }) })).links.cors.ok).toBe(false);
  });

  it("concatenates all failures in diagnosis", () => {
    const r = verifyDashboardChain("my-sandbox", chain, deps({ executeSandboxCommand: () => ({ status: 0, stdout: "000" }), captureForwardList: () => null, downloadSandboxConfig: () => null }));
    expect(r.healthy).toBe(false);
    expect(r.diagnosis).toContain("gateway");
    expect(r.diagnosis).toContain("forward");
    expect(r.diagnosis).toContain("cors");
  });
});
