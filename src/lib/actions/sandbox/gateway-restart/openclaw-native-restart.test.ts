// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
} from "../../../sandbox/privileged-exec";
import { restartOpenClawGatewayThroughProvider } from "./openclaw-native-restart";

vi.mock("../../../sandbox/privileged-exec", () => ({
  executePrivilegedSandboxCommand: vi.fn(),
  resolvePrivilegedSandboxTarget: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolvePrivilegedSandboxTarget).mockReturnValue({
    providerId: "docker",
    resourceHandle: "pinned-container",
  });
  vi.mocked(executePrivilegedSandboxCommand).mockReturnValue({
    status: 0,
    signal: null,
    stdout: Buffer.from('{"ok":true,"result":"restarted"}'),
    stderr: Buffer.alloc(0),
  });
});

describe("host-authorized native OpenClaw restart", () => {
  it("pins the resource and drops privilege before loading native agent code", () => {
    expect(restartOpenClawGatewayThroughProvider("alpha").status).toBe(0);
    expect(executePrivilegedSandboxCommand).toHaveBeenCalledWith(
      "alpha",
      [
        "/usr/bin/setpriv",
        "--reuid=sandbox",
        "--regid=sandbox",
        "--init-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
        "/usr/bin/env",
        "-i",
        "HOME=/sandbox",
        "USER=sandbox",
        "LOGNAME=sandbox",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "OPENSHELL_SANDBOX=1",
        "/usr/local/bin/openclaw",
        "gateway",
        "restart",
        "--json",
      ],
      { sanitizeEnvironment: true, expectedResourceHandle: "pinned-container", timeout: 210000 },
    );
  });

  it.each([
    { gatewayName: "another-gateway", workspace: "default" },
    { gatewayName: "gateway-alpha", workspace: "another-workspace" },
  ])("refuses a selection outside the registered provider target: %j", (selection) => {
    expect(restartOpenClawGatewayThroughProvider("alpha", selection, "gateway-alpha").status).toBe(
      1,
    );
    expect(resolvePrivilegedSandboxTarget).not.toHaveBeenCalled();
    expect(executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("accepts the matching explicit runtime selection", () => {
    expect(
      restartOpenClawGatewayThroughProvider(
        "alpha",
        {
          gatewayName: "gateway-alpha",
          workspace: "default",
        },
        "gateway-alpha",
      ).status,
    ).toBe(0);
  });

  it("propagates target refusal without attempting agent execution", () => {
    vi.mocked(resolvePrivilegedSandboxTarget).mockImplementation(() => {
      throw new Error("ambiguous sandbox identity");
    });
    expect(restartOpenClawGatewayThroughProvider("alpha")).toEqual({
      status: 1,
      stdout: "",
      stderr: "ambiguous sandbox identity",
    });
    expect(executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("does not convert transport failure into a successful restart", () => {
    vi.mocked(executePrivilegedSandboxCommand).mockReturnValue({
      status: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: new Error("runtime unavailable"),
    });
    expect(restartOpenClawGatewayThroughProvider("alpha")).toEqual({
      status: 1,
      stdout: "",
      stderr: "runtime unavailable",
    });
  });
});
