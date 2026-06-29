// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dangerousCapabilities,
  securityPostureEnabled,
  securityPostureModeEnv,
} from "../fixtures/security-posture.ts";

afterEach(() => vi.unstubAllEnvs());

describe("security posture fixture", () => {
  it("decodes the dangerous Linux capability bits", () => {
    expect(dangerousCapabilities("00200000")).toEqual(["CAP_SYS_ADMIN"]);
    expect(dangerousCapabilities("00002402")).toEqual([
      "CAP_NET_RAW",
      "CAP_NET_BIND_SERVICE",
      "CAP_DAC_OVERRIDE",
    ]);
    expect(dangerousCapabilities("00000000")).toEqual([]);
    expect(dangerousCapabilities("not-hex")).toEqual([]);
  });

  it("only forwards the explicit security-posture mode", () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", undefined);
    expect(securityPostureEnabled()).toBe(false);
    expect(securityPostureModeEnv()).toEqual({});

    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    expect(securityPostureEnabled()).toBe(true);
    expect(securityPostureModeEnv()).toEqual({
      NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST: "1",
      NEMOCLAW_E2E_SECURITY_POSTURE: "1",
    });
  });
});
