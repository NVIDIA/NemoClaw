// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assertOpenShellGatewayStopResult } from "../live/openshell-gateway-stop.ts";

describe("OpenShell gateway stop result", () => {
  it("accepts a successful stop", () => {
    expect(() =>
      assertOpenShellGatewayStopResult({ exitCode: 0, stdout: "Gateway stopped", stderr: "" }),
    ).not.toThrow();
  });

  it("accepts a missing gateway metadata diagnostic", () => {
    expect(() =>
      assertOpenShellGatewayStopResult({
        exitCode: 1,
        stdout: "",
        stderr: "No gateway metadata found for nemoclaw",
      }),
    ).not.toThrow();
  });

  it.each(["permission denied", "No gateway metadata found for nemoclaw; permission denied"])(
    "rejects another failure with its diagnostic: %s",
    (diagnostic) => {
      expect(() =>
        assertOpenShellGatewayStopResult({ exitCode: 1, stdout: "", stderr: diagnostic }),
      ).toThrow(diagnostic);
    },
  );
});
