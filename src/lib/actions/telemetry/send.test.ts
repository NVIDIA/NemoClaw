// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TELEMETRY_DELIVERY_DEADLINE_MS } from "../../adapters/telemetry/http";
import {
  buildInstallCompletedEvent,
  buildConfigurationCompletedEvent,
  type TelemetryEvent,
} from "../../domain/telemetry/event";
import { UNKNOWN_TELEMETRY_CONFIGURATION } from "../../domain/telemetry/dimensions";
import { MAX_TELEMETRY_BATCH_EVENTS } from "../../domain/telemetry/observations";
import {
  sendInstallerTelemetry,
  sendConfigurationTelemetry,
  sendConfigurationSnapshotTelemetry,
  shouldSuppressTelemetry,
  loadTelemetryConfig,
} from "./send";

describe("installer telemetry client", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", undefined);
    vi.stubEnv("NEMOCLAW_TELEMETRY_ENV", undefined);
    vi.stubEnv("NEMOCLAW_DISABLE_TELEMETRY", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("GITHUB_ACTIONS", "");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NEMOCLAW_RUN_LIVE_E2E", "");
    vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", "");
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["NEMOCLAW_DISABLE_TELEMETRY", "1"],
    ["CI", "true"],
    ["CI", "1"],
    ["GITHUB_ACTIONS", "true"],
    ["VITEST", "true"],
    ["NEMOCLAW_RUN_LIVE_E2E", "1"],
    ["NEMOCLAW_E2E_EXPECTED_SHA", "test-candidate"],
    ["NODE_ENV", "test"],
  ] as const)("suppresses telemetry for %s=%s before any work (#10440)", async (name, value) => {
    vi.stubEnv("NEMOCLAW_TELEMETRY_ENV", "uat");
    vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", "qa-campaign:case:attempt-1");
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

  it("selects only the fixed UAT endpoint with an explicit valid QA label", () => {
    const testLabel = "qa-campaign:case:attempt-1";
    expect(
      loadTelemetryConfig({
        NEMOCLAW_TELEMETRY_ENV: "uat",
        NEMOCLAW_TELEMETRY_TEST_LABEL: testLabel,
      })?.endpoint.href,
    ).toBe("https://events.telemetry.data-uat.nvidia.com/v1.1/events/json");
  });

  it.each([
    {},
    { NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-campaign:case:attempt-1" },
    {
      NEMOCLAW_TELEMETRY_ENV: "production",
      NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-campaign:case:attempt-1",
    },
    { NEMOCLAW_TELEMETRY_ENV: "UAT", NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-campaign:case:attempt-1" },
    { NEMOCLAW_TELEMETRY_ENV: "uat" },
    { NEMOCLAW_TELEMETRY_ENV: "uat", NEMOCLAW_TELEMETRY_TEST_LABEL: "" },
    { NEMOCLAW_TELEMETRY_ENV: "uat", NEMOCLAW_TELEMETRY_TEST_LABEL: "private@example.com" },
  ])("rejects incomplete or invalid UAT configuration %j", (env) => {
    expect(loadTelemetryConfig(env)).toBeNull();
  });

  it.each([
    ["NEMOCLAW_DISABLE_TELEMETRY", "1"],
    ["CI", "true"],
    ["CI", "1"],
    ["GITHUB_ACTIONS", "true"],
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
    ["NEMOCLAW_RUN_LIVE_E2E", "1"],
    ["NEMOCLAW_E2E_EXPECTED_SHA", "candidate"],
  ])("keeps UAT disabled when %s=%s suppresses collection", (name, value) => {
    expect(
      loadTelemetryConfig({
        NEMOCLAW_TELEMETRY_ENV: "uat",
        NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-campaign:case:attempt-1",
        [name]: value,
      }),
    ).toBeNull();
  });

  it("rejects an unmarked UAT command before configuration or collection", async () => {
    vi.stubEnv("NEMOCLAW_TELEMETRY_ENV", "uat");
    const loadConfig = vi.fn(() => ({ endpoint: new URL("http://127.0.0.1/events") }));
    const buildEvent = vi.fn(buildInstallCompletedEvent);
    const loadSnapshot = vi.fn(() => ({ ...UNKNOWN_TELEMETRY_CONFIGURATION }));
    const loadBatch = vi.fn((): readonly TelemetryEvent[] => [
      { event: "nemoclaw_sandbox_count_observed", operation: "onboard", count: 0 },
    ]);
    await expect(sendInstallerTelemetry("install", { loadConfig, buildEvent })).resolves.toBe(
      "suppressed",
    );
    await expect(sendConfigurationTelemetry("onboard", loadSnapshot, { loadConfig })).resolves.toBe(
      "suppressed",
    );
    await expect(
      sendConfigurationSnapshotTelemetry("onboard", loadBatch, { loadConfig }),
    ).resolves.toBe("suppressed");
    expect(loadConfig).not.toHaveBeenCalled();
    expect(buildEvent).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(loadBatch).not.toHaveBeenCalled();
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

  it.each([
    ["NEMOCLAW_DISABLE_TELEMETRY", "1"],
    ["CI", "true"],
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
    ["NEMOCLAW_RUN_LIVE_E2E", "1"],
    ["NEMOCLAW_E2E_EXPECTED_SHA", "test-candidate"],
  ] as const)(
    "does not read configuration when %s suppresses collection (#10448)",
    async (name, value) => {
      vi.stubEnv(name, value);
      const loadConfig = vi.fn(() => ({ endpoint: new URL("http://127.0.0.1/events") }));
      const loadSnapshot = vi.fn(() => ({ ...UNKNOWN_TELEMETRY_CONFIGURATION }));
      const deliverEvent = vi.fn(async () => "delivered" as const);
      await expect(
        sendConfigurationTelemetry("onboard", loadSnapshot, { loadConfig, deliverEvent }),
      ).resolves.toBe("suppressed");
      expect(loadConfig).not.toHaveBeenCalled();
      expect(loadSnapshot).not.toHaveBeenCalled();
      expect(deliverEvent).not.toHaveBeenCalled();
    },
  );

  it("does not read configuration while production is disabled (#10448)", async () => {
    const loadSnapshot = vi.fn(() => ({ ...UNKNOWN_TELEMETRY_CONFIGURATION }));
    await expect(sendConfigurationTelemetry("onboard", loadSnapshot)).resolves.toBe("disabled");
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("gates a configuration read before one bounded delivery (#10448)", async () => {
    const order: string[] = [];
    const endpoint = new URL("http://127.0.0.1/events");
    const snapshot = { ...UNKNOWN_TELEMETRY_CONFIGURATION };
    const deliverEvent = vi.fn(async () => {
      order.push("deliver");
      return "delivered" as const;
    });
    await expect(
      sendConfigurationTelemetry(
        "inference_set",
        () => {
          order.push("snapshot");
          return snapshot;
        },
        {
          loadConfig: () => {
            order.push("config");
            return { endpoint };
          },
          monotonicNow: () => 0,
          deliverEvent,
        },
      ),
    ).resolves.toBe("delivered");
    expect(order).toEqual(["config", "snapshot", "deliver"]);
    expect(deliverEvent).toHaveBeenCalledExactlyOnceWith(
      { endpoint },
      buildConfigurationCompletedEvent("inference_set", snapshot),
      TELEMETRY_DELIVERY_DEADLINE_MS,
    );
  });

  it.each([
    ["absent", (): null => null],
    [
      "throws",
      () => {
        throw new Error("private diagnostic");
      },
    ],
    [
      "invalid",
      () =>
        ({
          ...UNKNOWN_TELEMETRY_CONFIGURATION,
          modelId: "private",
        }) as unknown as typeof UNKNOWN_TELEMETRY_CONFIGURATION,
    ],
  ] as const)(
    "skips delivery when the configuration snapshot is %s (#10448)",
    async (_scenario, loadSnapshot) => {
      const deliverEvent = vi.fn(async () => "delivered" as const);
      await expect(
        sendConfigurationTelemetry("onboard", loadSnapshot, {
          loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
          deliverEvent,
        }),
      ).resolves.toBe("failed");
      expect(deliverEvent).not.toHaveBeenCalled();
    },
  );

  it("counts configuration collection within the delivery deadline (#10448)", async () => {
    let elapsedMs = 0;
    const endpoint = new URL("http://127.0.0.1/events");
    const snapshot = { ...UNKNOWN_TELEMETRY_CONFIGURATION };
    const deliverEvent = vi.fn(async () => "delivered" as const);
    await expect(
      sendConfigurationTelemetry(
        "onboard",
        () => {
          elapsedMs = 100;
          return snapshot;
        },
        { loadConfig: () => ({ endpoint }), monotonicNow: () => elapsedMs, deliverEvent },
      ),
    ).resolves.toBe("delivered");
    expect(deliverEvent).toHaveBeenCalledExactlyOnceWith(
      { endpoint },
      buildConfigurationCompletedEvent("onboard", snapshot),
      TELEMETRY_DELIVERY_DEADLINE_MS - 100,
    );
  });

  it.each([5_000, 5_001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.1])(
    "does not deliver after invalid or expired collection time %s (#10448)",
    async (elapsedMs) => {
      const monotonicNow = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(elapsedMs);
      const deliverEvent = vi.fn(async () => "delivered" as const);
      await expect(
        sendConfigurationTelemetry("onboard", () => ({ ...UNKNOWN_TELEMETRY_CONFIGURATION }), {
          loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
          monotonicNow,
          deliverEvent,
        }),
      ).resolves.toBe("failed");
      expect(deliverEvent).not.toHaveBeenCalled();
    },
  );

  it("does not retry a failed configuration delivery (#10448)", async () => {
    const deliverEvent = vi.fn(async () => {
      throw new Error("receiver unavailable");
    });
    await expect(
      sendConfigurationTelemetry("onboard", () => ({ ...UNKNOWN_TELEMETRY_CONFIGURATION }), {
        loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
        deliverEvent,
      }),
    ).resolves.toBe("failed");
    expect(deliverEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["NEMOCLAW_DISABLE_TELEMETRY", "1"],
    ["CI", "true"],
    ["GITHUB_ACTIONS", "true"],
    ["VITEST", "true"],
    ["NODE_ENV", "test"],
    ["NEMOCLAW_RUN_LIVE_E2E", "1"],
    ["NEMOCLAW_E2E_EXPECTED_SHA", "test-candidate"],
  ] as const)(
    "does not collect a complete snapshot when %s suppresses telemetry (#10442)",
    async (name, value) => {
      vi.stubEnv(name, value);
      const loadConfig = vi.fn(() => ({ endpoint: new URL("http://127.0.0.1/events") }));
      const loadSnapshot = vi.fn((): readonly TelemetryEvent[] => [
        { event: "nemoclaw_sandbox_count_observed", operation: "destroy", count: 0 },
      ]);
      const deliverBatch = vi.fn(async () => "delivered" as const);
      await expect(
        sendConfigurationSnapshotTelemetry("destroy", loadSnapshot, { loadConfig, deliverBatch }),
      ).resolves.toBe("suppressed");
      expect(loadConfig).not.toHaveBeenCalled();
      expect(loadSnapshot).not.toHaveBeenCalled();
      expect(deliverBatch).not.toHaveBeenCalled();
    },
  );

  it("does not collect a complete snapshot while production is disabled (#10442)", async () => {
    const loadSnapshot = vi.fn((): readonly TelemetryEvent[] => [
      { event: "nemoclaw_sandbox_count_observed", operation: "destroy", count: 0 },
    ]);
    const deliverBatch = vi.fn(async () => "delivered" as const);
    await expect(
      sendConfigurationSnapshotTelemetry("destroy", loadSnapshot, { deliverBatch }),
    ).resolves.toBe("disabled");
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(deliverBatch).not.toHaveBeenCalled();
  });

  it("gates one complete snapshot before one delivery with the remaining deadline (#10442)", async () => {
    const order: string[] = [];
    const endpoint = new URL("http://127.0.0.1/events");
    const events: readonly TelemetryEvent[] = [
      { event: "nemoclaw_sandbox_count_observed", operation: "destroy", count: 0 },
    ];
    let elapsed = 0;
    const deliverBatch = vi.fn(
      async (
        _config: { endpoint: URL },
        _events: readonly TelemetryEvent[],
        _deadlineMs: number,
      ) => {
        order.push("deliver");
        return "delivered" as const;
      },
    );
    await expect(
      sendConfigurationSnapshotTelemetry(
        "destroy",
        () => {
          order.push("snapshot");
          elapsed = 100.1;
          return events;
        },
        {
          loadConfig: () => {
            order.push("config");
            return { endpoint };
          },
          monotonicNow: () => elapsed,
          deliverBatch,
        },
      ),
    ).resolves.toBe("delivered");
    expect(order).toEqual(["config", "snapshot", "deliver"]);
    expect(deliverBatch).toHaveBeenCalledExactlyOnceWith(
      { endpoint },
      events,
      TELEMETRY_DELIVERY_DEADLINE_MS - 101,
    );
    expect(Object.isFrozen(deliverBatch.mock.calls[0]?.[1])).toBe(true);
  });

  it.each([
    { value: null },
    { value: [] },
    { value: [{ event: "nemoclaw_install_completed", operation: "install" }] },
    { value: [{ event: "nemoclaw_sandbox_count_observed", operation: "restore", count: 0 }] },
    {
      value: [
        { event: "nemoclaw_sandbox_count_observed", operation: "destroy", count: 0 },
        {
          event: "nemoclaw_agent_runtime_observed",
          operation: "destroy",
          agent_runtime: "openclaw",
          count: 1,
          privateValue: "secret",
        },
      ],
    },
    {
      value: Array.from({ length: MAX_TELEMETRY_BATCH_EVENTS + 1 }, () => ({
        event: "nemoclaw_sandbox_count_observed",
        operation: "destroy",
        count: 0,
      })),
    },
  ])(
    "rejects a missing, invalid, mixed, or oversized complete batch (#10442)",
    async ({ value }) => {
      const deliverBatch = vi.fn(async () => "delivered" as const);
      await expect(
        sendConfigurationSnapshotTelemetry(
          "destroy",
          () => value as readonly TelemetryEvent[] | null,
          {
            loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
            monotonicNow: () => 0,
            deliverBatch,
          },
        ),
      ).resolves.toBe("failed");
      expect(deliverBatch).not.toHaveBeenCalled();
    },
  );

  it.each([5_000, 5_001, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not send a complete batch after invalid or expired collection time %s (#10442)",
    async (elapsed) => {
      const deliverBatch = vi.fn(async () => "delivered" as const);
      const monotonicNow = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(elapsed);
      await expect(
        sendConfigurationSnapshotTelemetry(
          "destroy",
          () => [{ event: "nemoclaw_sandbox_count_observed", operation: "destroy", count: 0 }],
          {
            loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
            monotonicNow,
            deliverBatch,
          },
        ),
      ).resolves.toBe("failed");
      expect(deliverBatch).not.toHaveBeenCalled();
    },
  );

  it("does not send a partial batch when snapshot collection throws (#10442)", async () => {
    const deliverBatch = vi.fn(async () => "delivered" as const);
    await expect(
      sendConfigurationSnapshotTelemetry(
        "destroy",
        () => {
          throw new Error("private collection detail");
        },
        {
          loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
          deliverBatch,
        },
      ),
    ).resolves.toBe("failed");
    expect(deliverBatch).not.toHaveBeenCalled();
  });

  it("attempts a failing complete batch once without changing its input (#10442)", async () => {
    const events: readonly TelemetryEvent[] = Object.freeze<TelemetryEvent[]>([
      { event: "nemoclaw_sandbox_count_observed", operation: "destroy", count: 0 },
    ]);
    const deliverBatch = vi.fn(async () => {
      throw new Error("receiver unavailable");
    });
    await expect(
      sendConfigurationSnapshotTelemetry("destroy", () => events, {
        loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
        monotonicNow: () => 0,
        deliverBatch,
      }),
    ).resolves.toBe("failed");
    expect(deliverBatch).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { event: "nemoclaw_sandbox_count_observed", operation: "destroy", count: 0 },
    ]);
  });

  it.each(["", "private@example.com", "qa-a:b:attempt-1\n"])(
    "suppresses invalid QA label %j before configuration or state collection",
    async (testLabel) => {
      vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", testLabel);
      const loadConfig = vi.fn(() => ({ endpoint: new URL("http://127.0.0.1/events") }));
      const buildEvent = vi.fn(buildInstallCompletedEvent);
      const loadSnapshot = vi.fn(() => ({ ...UNKNOWN_TELEMETRY_CONFIGURATION }));
      const loadBatch = vi.fn((): readonly TelemetryEvent[] => [
        { event: "nemoclaw_sandbox_count_observed", operation: "onboard", count: 0 },
      ]);
      await expect(sendInstallerTelemetry("install", { loadConfig, buildEvent })).resolves.toBe(
        "suppressed",
      );
      await expect(
        sendConfigurationTelemetry("onboard", loadSnapshot, { loadConfig }),
      ).resolves.toBe("suppressed");
      await expect(
        sendConfigurationSnapshotTelemetry("onboard", loadBatch, { loadConfig }),
      ).resolves.toBe("suppressed");
      expect(loadConfig).not.toHaveBeenCalled();
      expect(buildEvent).not.toHaveBeenCalled();
      expect(loadSnapshot).not.toHaveBeenCalled();
      expect(loadBatch).not.toHaveBeenCalled();
    },
  );

  it("marks one command without persisting its label into a later ordinary command", async () => {
    const endpoint = new URL("http://127.0.0.1/events");
    const deliverEvent = vi.fn(
      async (_config: { endpoint: URL }, _event: TelemetryEvent, _deadlineMs: number) =>
        "delivered" as const,
    );
    vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", "qa-campaign:case:attempt-1");
    await sendInstallerTelemetry("install", { loadConfig: () => ({ endpoint }), deliverEvent });
    vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", undefined);
    await sendInstallerTelemetry("install", { loadConfig: () => ({ endpoint }), deliverEvent });
    expect(deliverEvent).toHaveBeenCalledTimes(2);
    expect(deliverEvent.mock.calls[0]?.[1]).toHaveProperty(
      "testLabel",
      "qa-campaign:case:attempt-1",
    );
    expect(deliverEvent.mock.calls[1]?.[1]).not.toHaveProperty("testLabel");
  });

  it("attaches the same valid QA label to configuration and complete snapshots", async () => {
    const testLabel = "qa-campaign:case:attempt-1";
    vi.stubEnv("NEMOCLAW_TELEMETRY_ENV", "uat");
    vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", testLabel);
    const deliverEvent = vi.fn(async () => "delivered" as const);
    const deliverBatch = vi.fn(async () => "delivered" as const);
    await expect(
      sendConfigurationTelemetry("onboard", () => UNKNOWN_TELEMETRY_CONFIGURATION, {
        monotonicNow: () => 0,
        deliverEvent,
      }),
    ).resolves.toBe("delivered");
    await expect(
      sendConfigurationSnapshotTelemetry(
        "onboard",
        () => [{ event: "nemoclaw_sandbox_count_observed", operation: "onboard", count: 0 }],
        { monotonicNow: () => 0, deliverBatch },
      ),
    ).resolves.toBe("delivered");
    expect(deliverEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ testLabel }),
      5000,
    );
    expect(deliverBatch).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ testLabel })],
      5000,
    );
  });

  it("rejects a conflicting pre-labeled event instead of replacing its label", async () => {
    vi.stubEnv("NEMOCLAW_TELEMETRY_TEST_LABEL", "qa-campaign:case:attempt-1");
    const deliverEvent = vi.fn(async () => "delivered" as const);
    await expect(
      sendInstallerTelemetry("install", {
        loadConfig: () => ({ endpoint: new URL("http://127.0.0.1/events") }),
        buildEvent: () => ({
          event: "nemoclaw_install_completed",
          operation: "install",
          testLabel: "qa-other:case:attempt-2",
        }),
        deliverEvent,
      }),
    ).resolves.toBe("failed");
    expect(deliverEvent).not.toHaveBeenCalled();
  });
});
