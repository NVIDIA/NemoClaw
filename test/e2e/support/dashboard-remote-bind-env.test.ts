// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { buildDashboardRemoteBindEnv } from "../live/dashboard-remote-bind-env.ts";

describe("dashboard remote-bind E2E environment", () => {
  it("prepares remote dashboard exposure during install and onboarding", () => {
    const env = buildDashboardRemoteBindEnv("e2e-dashboard-remote-bind", {
      NVIDIA_INFERENCE_API_KEY: "test-key",
    });

    expect(env).toMatchObject({
      NEMOCLAW_DASHBOARD_BIND: "0.0.0.0",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-dashboard-remote-bind",
      NVIDIA_INFERENCE_API_KEY: "test-key",
    });
    expect(env.PATH).toContain(buildAvailabilityProbeEnv().PATH);
  });

  it("does not allow command overlays to disable remote exposure preparation", () => {
    const env = buildDashboardRemoteBindEnv("e2e-dashboard-remote-bind", {
      NEMOCLAW_DASHBOARD_BIND: "127.0.0.1",
    });

    expect(env.NEMOCLAW_DASHBOARD_BIND).toBe("0.0.0.0");
  });
});
