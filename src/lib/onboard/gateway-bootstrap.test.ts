// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildGatewayBootstrapSecretsScript,
  createGatewayBootstrapRepairHelpers,
  getGatewayBootstrapRepairPlan,
} from "./gateway-bootstrap";

describe("gateway bootstrap helpers", () => {
  it("normalizes missing secrets into a repair plan", () => {
    expect(
      getGatewayBootstrapRepairPlan([
        "openshell-client-tls",
        "noise",
        " openshell-server-tls ",
        "",
      ]),
    ).toEqual({
      missingSecrets: ["openshell-client-tls", "openshell-server-tls"],
      needsRepair: true,
      needsServerTls: true,
      needsClientBundle: true,
      needsHandshake: false,
    });
  });

  it("builds a no-op script when nothing is missing", () => {
    expect(buildGatewayBootstrapSecretsScript([]).trim()).toBe("exit 0");
  });

  it("builds a repair script only for requested secret classes", () => {
    const script = buildGatewayBootstrapSecretsScript([
      "openshell-server-tls",
      "openshell-ssh-handshake",
    ]);

    expect(script).toContain("openshell-server-tls");
    expect(script).toContain("openshell-ssh-handshake");
    expect(script).toContain("if true; then");
    expect(script).toContain("if false; then");
  });

  it("lists missing secrets through the gateway cluster executor", () => {
    const buildGatewayClusterExecArgv = vi.fn((script: string) => ["docker", "exec", script]);
    const runCapture = vi.fn(() => "openshell-client-tls\n\nopenshell-server-tls\n");
    const helpers = createGatewayBootstrapRepairHelpers({
      buildGatewayClusterExecArgv,
      run: vi.fn(() => ({ status: 0 })),
      runCapture,
    });

    expect(helpers.listMissingGatewayBootstrapSecrets()).toEqual([
      "openshell-client-tls",
      "openshell-server-tls",
    ]);
    expect(runCapture).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("kubectl -n openshell get secret")]),
      { ignoreError: true },
    );
  });

  it("repairs missing secrets and reports success when the second probe is clean", () => {
    const log = vi.fn();
    const runCapture = vi
      .fn()
      .mockReturnValueOnce("openshell-client-tls\n")
      .mockReturnValueOnce("");
    const run = vi.fn(() => ({ status: 0 }));
    const helpers = createGatewayBootstrapRepairHelpers({
      buildGatewayClusterExecArgv: (script) => ["docker", "exec", script],
      run,
      runCapture,
      log,
    });

    expect(helpers.repairGatewayBootstrapSecrets()).toEqual({ repaired: true, missingSecrets: [] });
    expect(run).toHaveBeenCalledWith(expect.any(Array), {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(log).toHaveBeenCalledWith("  ✓ OpenShell bootstrap secrets created");
  });
});
