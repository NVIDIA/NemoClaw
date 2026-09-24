// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isPodmanGatewayRuntimeEnabled,
  resolveNemoClawGatewayRuntime,
} from "./runtime-provider/configured-runtime";

describe("gateway runtime selection", () => {
  it.each([{}, { NEMOCLAW_GATEWAY_RUNTIME: "" }, { NEMOCLAW_GATEWAY_RUNTIME: "docker" }])(
    "keeps Docker as the default",
    (env) => {
      expect(resolveNemoClawGatewayRuntime(env)).toBe("docker");
      expect(isPodmanGatewayRuntimeEnabled(env)).toBe(false);
    },
  );

  it("restores the explicit native Podman selector", () => {
    expect(resolveNemoClawGatewayRuntime({ NEMOCLAW_GATEWAY_RUNTIME: "podman" })).toBe("podman");
  });

  it("rejects unknown values", () => {
    expect(() => resolveNemoClawGatewayRuntime({ NEMOCLAW_GATEWAY_RUNTIME: "portable" })).toThrow(
      'NEMOCLAW_GATEWAY_RUNTIME must be either "docker" or "podman"',
    );
  });
});
