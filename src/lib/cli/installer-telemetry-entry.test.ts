// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendInstallerTelemetry = vi.hoisted(() => vi.fn());

vi.mock("../actions/telemetry/send", () => ({ sendInstallerTelemetry }));

import { TELEMETRY_OPERATIONS } from "../domain/telemetry/event";
import { runInstallerTelemetryEntry } from "./installer-telemetry-entry";

describe("installer telemetry entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendInstallerTelemetry.mockResolvedValue("disabled");
  });

  it.each(TELEMETRY_OPERATIONS)(
    "forwards only the %s operation to the telemetry client (#10440)",
    async (operation) => {
      await runInstallerTelemetryEntry([operation]);

      expect(sendInstallerTelemetry).toHaveBeenCalledExactlyOnceWith(operation);
    },
  );

  it.each([
    { scenario: "a missing operation", args: [] },
    { scenario: "an unsupported operation", args: ["upgrade"] },
    { scenario: "an extra argument", args: ["install", "extra"] },
  ])("rejects $scenario before sending (#10440)", async ({ args }) => {
    await expect(runInstallerTelemetryEntry(args)).rejects.toThrow();
    expect(sendInstallerTelemetry).not.toHaveBeenCalled();
  });
});
