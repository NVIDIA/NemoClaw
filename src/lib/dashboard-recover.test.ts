// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import { recoverDashboardChain } from "../../dist/lib/dashboard-recover";
import { buildChain } from "../../dist/lib/dashboard-contract";

const chain = buildChain();

function deps(overrides = {}) {
  return {
    executeSandboxCommand: vi.fn().mockReturnValue({ status: 0, stdout: "200" }),
    captureForwardList: vi.fn().mockReturnValue("my-sandbox  127.0.0.1  18789  12345  running"),
    downloadSandboxConfig: vi.fn().mockReturnValue({ gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } } }),
    restartGateway: vi.fn().mockReturnValue(true),
    stopForward: vi.fn(), startForward: vi.fn(),
    getSessionAgent: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

describe("recoverDashboardChain", () => {
  it("no-ops when healthy", () => {
    const d = deps();
    expect(recoverDashboardChain("my-sandbox", chain, d).attempted).toBe(false);
    expect(d.restartGateway).not.toHaveBeenCalled();
  });

  it("restarts gateway and checks return value", () => {
    let n = 0;
    const d = deps({ executeSandboxCommand: vi.fn(() => ({ status: 0, stdout: ++n <= 1 ? "000" : "200" })) });
    const r = recoverDashboardChain("my-sandbox", chain, d);
    expect(r.attempted).toBe(true);
    expect(r.actions).toContain("restarted gateway");
    expect(d.restartGateway).toHaveBeenCalled();
  });

  it("reports gateway restart failure", () => {
    const d = deps({
      executeSandboxCommand: vi.fn().mockReturnValue({ status: 0, stdout: "000" }),
      restartGateway: vi.fn().mockReturnValue(false),
    });
    const r = recoverDashboardChain("my-sandbox", chain, d);
    expect(r.actions).toContain("gateway restart failed");
  });

  it("re-establishes missing forward", () => {
    let n = 0;
    const d = deps({ captureForwardList: vi.fn(() => ++n <= 1 ? null : "my-sandbox  127.0.0.1  18789  12345  running") });
    const r = recoverDashboardChain("my-sandbox", chain, d);
    expect(r.actions).toContain("re-established forward");
    expect(d.stopForward).toHaveBeenCalled();
  });

  it("diagnoses CORS mismatch without auto-fixing", () => {
    const d = deps({ downloadSandboxConfig: vi.fn().mockReturnValue({ gateway: { controlUi: { allowedOrigins: [] } } }) });
    expect(recoverDashboardChain("my-sandbox", chain, d).actions.some(a => a.includes("CORS"))).toBe(true);
  });
});
