// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TELEMETRY_DELIVERY_DEADLINE_MS } from "../../adapters/telemetry/http";
import { buildInstallCompletedEvent } from "../../domain/telemetry/event";
import { sendInstallerTelemetry, shouldSuppressTelemetry } from "./send";

describe("installer telemetry client", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_DISABLE_TELEMETRY", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["NEMOCLAW_DISABLE_TELEMETRY", "1"],
    ["CI", "true"],
    ["CI", "1"],
    ["GITHUB_ACTIONS", "true"],
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
  ] as const)("suppresses telemetry for %s=%s before any work (#10440)", async (name, value) => {
    vi.stubEnv(name, value);
    const loadConfig = vi.fn(() => ({ endpoint: new URL("http://127.0.0.1/events") }));
    const buildEvent = vi.fn(buildInstallCompletedEvent);
    const deliverEvent = vi.fn(async () => "delivered" as const);

    await expect(
      sendInstallerTelemetry("install", { loadConfig, buildEvent, deliverEvent }),
    ).resolves.toBe("suppressed");

    expect(loadConfig).not.toHaveBeenCalled();
    expect(buildEvent).not.toHaveBeenCalled();
    expect(deliverEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["NEMOCLAW_DISABLE_TELEMETRY", "true"],
    ["CI", "false"],
    ["GITHUB_ACTIONS", "1"],
    ["VITEST", "1"],
    ["NODE_ENV", "testing"],
  ] as const)("does not suppress for the near-miss %s=%s (#10440)", (name, value) => {
    expect(shouldSuppressTelemetry({ [name]: value })).toBe(false);
  });

  it("does not let injected dependencies bypass ambient suppression (#10440)", async () => {
    vi.stubEnv("NEMOCLAW_DISABLE_TELEMETRY", "1");
    const loadConfig = vi.fn(() => ({ endpoint: new URL("http://127.0.0.1/events") }));
    const buildEvent = vi.fn(buildInstallCompletedEvent);
    const deliverEvent = vi.fn(async () => "delivered" as const);

    await expect(
      sendInstallerTelemetry("install", {
        loadConfig,
        buildEvent,
        deliverEvent,
      }),
    ).resolves.toBe("suppressed");

    expect(loadConfig).not.toHaveBeenCalled();
    expect(buildEvent).not.toHaveBeenCalled();
    expect(deliverEvent).not.toHaveBeenCalled();
  });

  it("keeps production delivery disabled before building an event (#10440)", async () => {
    const buildEvent = vi.fn(buildInstallCompletedEvent);
    const deliverEvent = vi.fn(async () => "delivered" as const);

    await expect(sendInstallerTelemetry("install", { buildEvent, deliverEvent })).resolves.toBe(
      "disabled",
    );

    expect(buildEvent).not.toHaveBeenCalled();
    expect(deliverEvent).not.toHaveBeenCalled();
  });

  it.each(["install", "update"] as const)(
    "builds and delivers one %s event with the production deadline (#10440)",
    async (operation) => {
      const endpoint = new URL("http://127.0.0.1/events");
      const deliverEvent = vi.fn(async () => "delivered" as const);

      await expect(
        sendInstallerTelemetry(operation, {
          loadConfig: () => ({ endpoint }),
          deliverEvent,
        }),
      ).resolves.toBe("delivered");

      expect(deliverEvent).toHaveBeenCalledExactlyOnceWith(
        { endpoint },
        {
          event: "nemoclaw_install_completed",
          operation,
        },
        TELEMETRY_DELIVERY_DEADLINE_MS,
      );
    },
  );

  it("swallows a delivery failure without retrying (#10440)", async () => {
    const deliverEvent = vi.fn(async () => {
      throw new Error("receiver unavailable");
    });

    await expect(
      sendInstallerTelemetry("install", {
        loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
        deliverEvent,
      }),
    ).resolves.toBe("failed");
    expect(deliverEvent).toHaveBeenCalledTimes(1);
  });
});
