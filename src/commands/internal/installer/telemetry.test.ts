// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendInstallerTelemetry = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/actions/telemetry/send", () => ({ sendInstallerTelemetry }));

import InternalInstallerTelemetryCommand from "./telemetry";

const rootDir = process.cwd();

describe("internal installer telemetry command", () => {
  beforeEach(() => {
    sendInstallerTelemetry.mockReset();
    sendInstallerTelemetry.mockResolvedValue("disabled");
  });

  it.each(["install", "update"] as const)(
    "forwards only the %s operation to TypeScript (#10440)",
    async (operation) => {
      await InternalInstallerTelemetryCommand.run([operation], rootDir);

      expect(sendInstallerTelemetry).toHaveBeenCalledExactlyOnceWith(operation);
    },
  );

  it.each([
    { scenario: "a missing operation", args: [] },
    { scenario: "an unsupported operation", args: ["upgrade"] },
    { scenario: "an extra argument", args: ["install", "extra"] },
  ])("rejects $scenario (#10440)", async ({ args }) => {
    await expect(InternalInstallerTelemetryCommand.run(args, rootDir)).rejects.toThrow();
    expect(sendInstallerTelemetry).not.toHaveBeenCalled();
  });
});
