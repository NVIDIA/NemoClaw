// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isRemoteDashboardBindRequested,
  resolveRequestedRemoteDashboardBind,
} from "./dockerfile-remote-dashboard-bind-contract";

describe("remote dashboard bind request policy", () => {
  it("accepts an explicit remote bind for a managed Dockerfile", () => {
    expect(resolveRequestedRemoteDashboardBind("0.0.0.0", true)).toBe("0.0.0.0");
    expect(isRemoteDashboardBindRequested("0.0.0.0")).toBe(true);
  });

  it("keeps an unset request on loopback", () => {
    expect(resolveRequestedRemoteDashboardBind(undefined, false)).toBe("");
    expect(resolveRequestedRemoteDashboardBind("", false)).toBe("");
  });

  it("rejects remote exposure for a custom Dockerfile", () => {
    expect(() => resolveRequestedRemoteDashboardBind("0.0.0.0", false)).toThrow(
      /custom --from Dockerfiles/,
    );
  });

  it("rejects unsupported bind values", () => {
    expect(() => resolveRequestedRemoteDashboardBind("127.0.0.1", true)).toThrow(
      "NEMOCLAW_DASHBOARD_BIND must be empty or 0.0.0.0.",
    );
  });
});
