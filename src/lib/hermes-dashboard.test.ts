// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  HERMES_DASHBOARD_DEFAULT_INTERNAL_PORT,
  HERMES_DASHBOARD_DEFAULT_PORT,
  readHermesDashboardConfig,
} from "./hermes-dashboard";

describe("Hermes dashboard config", () => {
  it("defaults to disabled dashboard settings", () => {
    expect(readHermesDashboardConfig({})).toEqual({
      enabled: false,
      port: HERMES_DASHBOARD_DEFAULT_PORT,
      internalPort: HERMES_DASHBOARD_DEFAULT_INTERNAL_PORT,
      tuiEnabled: false,
    });
  });

  it("reads opt-in dashboard settings from env", () => {
    expect(
      readHermesDashboardConfig({
        NEMOCLAW_HERMES_DASHBOARD: "true",
        NEMOCLAW_HERMES_DASHBOARD_PORT: "9120",
        NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "19120",
        NEMOCLAW_HERMES_DASHBOARD_TUI: "yes",
      }),
    ).toEqual({
      enabled: true,
      port: 9120,
      internalPort: 19120,
      tuiEnabled: true,
    });
  });

  it("rejects invalid port values", () => {
    expect(() =>
      readHermesDashboardConfig({
        NEMOCLAW_HERMES_DASHBOARD_PORT: "abc",
      }),
    ).toThrow(/NEMOCLAW_HERMES_DASHBOARD_PORT/);
    expect(() =>
      readHermesDashboardConfig({
        NEMOCLAW_HERMES_DASHBOARD_PORT: "1023",
      }),
    ).toThrow(/NEMOCLAW_HERMES_DASHBOARD_PORT/);
    expect(() =>
      readHermesDashboardConfig({
        NEMOCLAW_HERMES_DASHBOARD_PORT: "65536",
      }),
    ).toThrow(/NEMOCLAW_HERMES_DASHBOARD_PORT/);
  });
});
