// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { gatewayStartGuidance, resolveGatewayLauncher } from "./gateway-start-guidance";
import type { GatewayManagementDeclaration } from "./onboard/gateway-management";
import { resolveCurrentOpenShellComputePlan } from "./onboard/compute/plan";

const externallySupervisedDeclaration: GatewayManagementDeclaration = {
  version: 1,
  mode: "externally-supervised",
  endpoint: "http://127.0.0.1:8080",
  stateDir: "/var/lib/openshell",
  supervisor: {
    kind: "systemd-system",
    serviceName: "openshell-gateway.service",
    execPath: "/usr/bin/openshell-gateway",
  },
  requiredCapabilities: [],
};

describe("gatewayStartGuidance", () => {
  it("names the NemoClaw command where NemoClaw launches the gateway", () => {
    expect(gatewayStartGuidance("nemoclaw", "nemoclaw")).toBe(
      "Start the gateway again with `nemoclaw onboard`.",
    );
  });

  it("names the owning deployment and gateway selection where NemoClaw does not launch it", () => {
    const guidance = gatewayStartGuidance("nemoclaw-8091", "openshell");

    expect(guidance).toContain("does not start the 'nemoclaw-8091' gateway on this host");
    expect(guidance).toContain("openshell gateway select nemoclaw-8091");
  });

  it("marks the required gateway argument when the caller does not know its name", () => {
    expect(gatewayStartGuidance(undefined, "openshell")).toContain(
      "openshell gateway select <gateway>",
    );
  });

  it.each(["nemoclaw", "openshell"] as const)(
    "never names a gateway lifecycle command the OpenShell CLI does not have [case %#]",
    (launcher) => {
      expect(gatewayStartGuidance("nemoclaw", launcher)).not.toContain("openshell gateway start");
    },
  );

  it("reads the launcher the current runtime provider records", () => {
    expect(
      resolveGatewayLauncher({ plan: { gatewayLauncher: "openshell" }, declaration: null }),
    ).toBe("openshell");
    expect(resolveGatewayLauncher({ declaration: null })).toBe(
      resolveCurrentOpenShellComputePlan().gatewayLauncher,
    );
  });

  it("honors external lifecycle authority on a Docker-managed runtime", () => {
    expect(
      resolveGatewayLauncher({
        gatewayName: "nemoclaw",
        plan: { gatewayLauncher: "nemoclaw" },
        declaration: externallySupervisedDeclaration,
      }),
    ).toBe("openshell");
  });

  it("resolves the launcher from the plan when the caller supplies no override", () => {
    expect(gatewayStartGuidance("nemoclaw")).toBe(
      gatewayStartGuidance("nemoclaw", resolveGatewayLauncher({ gatewayName: "nemoclaw" })),
    );
  });

});
