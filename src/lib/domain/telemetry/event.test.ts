// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildInstallCompletedEvent,
  isInstallCompletedEvent,
  isTelemetryEvent,
  isTelemetryOperation,
} from "./event";

describe("install-completed telemetry event", () => {
  it.each(["install", "update"] as const)(
    "builds the closed %s event schema (#10440)",
    (operation) => {
      expect(buildInstallCompletedEvent(operation)).toEqual({
        event: "nemoclaw_install_completed",
        operation,
      });
    },
  );

  it.each(["upgrade", "install-failed", "", 1, null, undefined])(
    "rejects the non-allowlisted operation %j (#10440)",
    (operation) => {
      expect(isTelemetryOperation(operation)).toBe(false);
    },
  );

  it.each([
    { event: "nemoclaw_install_completed", operation: "upgrade" },
    { event: "arbitrary_event", operation: "install" },
    { event: "nemoclaw_install_completed", operation: "install", detail: "free-form" },
    { operation: "install" },
    null,
  ])("rejects an event outside the exact schema (#10440)", (event) => {
    expect(isInstallCompletedEvent(event)).toBe(false);
    expect(isTelemetryEvent(event)).toBe(false);
  });
});
