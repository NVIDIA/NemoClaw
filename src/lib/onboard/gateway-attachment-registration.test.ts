// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { bindExternallySupervisedGateway } from "./gateway-attachment-registration";
import { type GatewayOwner, GatewayOwnershipError } from "./gateway-ownership";

const OWNER: GatewayOwner = {
  mode: "externally-supervised",
  source: "declared",
  endpoint: "http://127.0.0.1:8080",
  stateDir: "/var/lib/openshell/gateway",
  supervisor: {
    kind: "systemd-system",
    serviceName: "openshell-gateway.service",
    execPath: "/usr/local/bin/openshell-gateway",
  },
  requiredCapabilities: [],
};

function info(name: string, endpoint: string): string {
  return `Gateway Info\n\nGateway: ${name}\nGateway endpoint: ${endpoint}/\n`;
}

describe("externally supervised gateway registration", () => {
  it("registers and selects the declared endpoint when no prior registration exists", () => {
    const commands: string[][] = [];
    let registered = false;
    const runOpenshell = vi.fn((args: string[]) => {
      commands.push(args);
      if (args[1] === "add") registered = true;
      return { status: 0 };
    });
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      if (!registered) return "No gateway metadata found";
      return info("nemoclaw", OWNER.endpoint!);
    });

    bindExternallySupervisedGateway(OWNER, "nemoclaw", {
      runOpenshell,
      runCaptureOpenshell,
    });

    expect(commands).toEqual([
      ["gateway", "add", OWNER.endpoint, "--local", "--name", "nemoclaw"],
      ["gateway", "select", "nemoclaw"],
    ]);
  });

  it("reselects the declared registration instead of leaving an ambient sibling active", () => {
    let selected = "sibling";
    const runOpenshell = vi.fn((args: string[]) => {
      if (args[1] === "select") selected = args[2];
      return { status: 0 };
    });
    const runCaptureOpenshell = vi.fn((args: string[]) =>
      args.includes("-g")
        ? info("nemoclaw", OWNER.endpoint!)
        : info(selected, selected === "nemoclaw" ? OWNER.endpoint! : "http://127.0.0.1:9090"),
    );

    bindExternallySupervisedGateway(OWNER, "nemoclaw", {
      runOpenshell,
      runCaptureOpenshell,
    });

    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "select", "nemoclaw"], {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(selected).toBe("nemoclaw");
  });

  it("fails closed when the canonical name points at a different endpoint", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => info("nemoclaw", "http://127.0.0.1:9090"));

    expect(() =>
      bindExternallySupervisedGateway(OWNER, "nemoclaw", {
        runOpenshell,
        runCaptureOpenshell,
      }),
    ).toThrow(GatewayOwnershipError);
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
