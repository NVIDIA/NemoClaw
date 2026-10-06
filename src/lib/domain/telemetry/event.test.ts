// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildInstallCompletedEvent,
  buildConfigurationCompletedEvent,
  isTelemetryOperation,
  parseInstallCompletedEvent,
  parseTelemetryEvent,
  isTelemetryTestLabel,
  readTelemetryTestLabel,
} from "./event";
import { UNKNOWN_TELEMETRY_CONFIGURATION } from "./dimensions";

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
    expect(parseInstallCompletedEvent(event)).toBeNull();
  });
});

describe("completed configuration telemetry event", () => {
  it.each(["onboard", "inference_set"] as const)(
    "builds a separate %s configuration event (#10448)",
    (operation) => {
      expect(
        buildConfigurationCompletedEvent(operation, { ...UNKNOWN_TELEMETRY_CONFIGURATION }),
      ).toEqual({
        event: "nemoclaw_configuration_completed",
        operation,
        configuration: UNKNOWN_TELEMETRY_CONFIGURATION,
      });
    },
  );

  it.each([
    {
      event: "nemoclaw_configuration_completed",
      operation: "install",
      configuration: UNKNOWN_TELEMETRY_CONFIGURATION,
    },
    {
      event: "nemoclaw_configuration_completed",
      operation: "onboard",
      configuration: { ...UNKNOWN_TELEMETRY_CONFIGURATION, modelId: "private" },
    },
    {
      event: "nemoclaw_configuration_completed",
      operation: "onboard",
      configuration: UNKNOWN_TELEMETRY_CONFIGURATION,
      sandboxName: "private",
    },
    {
      event: "nemoclaw_install_completed",
      operation: "install",
      configuration: UNKNOWN_TELEMETRY_CONFIGURATION,
    },
  ])("rejects invalid fields and mixed operation count units (#10448)", (value) => {
    expect(parseTelemetryEvent(value)).toBeNull();
  });

  it("copies only validated fields before serialization (#10448)", () => {
    const configuration = { ...UNKNOWN_TELEMETRY_CONFIGURATION };
    Object.defineProperty(configuration, "toJSON", {
      value: () => ({ credential: "private-secret" }),
    });
    const event = buildConfigurationCompletedEvent("onboard", configuration);
    expect(JSON.stringify(event)).not.toContain("private-secret");
    expect(event.configuration).not.toBe(configuration);
    expect(Object.isFrozen(event.configuration)).toBe(true);
  });
});

describe("temporary QA telemetry labels", () => {
  it("distinguishes an absent environment label from an assigned invalid value", () => {
    expect(readTelemetryTestLabel({})).toBeUndefined();
    expect(
      readTelemetryTestLabel({ NEMOCLAW_TELEMETRY_TEST_LABEL: "qa-campaign:case:attempt-1" }),
    ).toBe("qa-campaign:case:attempt-1");
  });
  it.each(["", undefined, "private@example.com", "qa-a:b:attempt-1\n"])(
    "rejects the assigned invalid environment label %j",
    (value) => {
      expect(readTelemetryTestLabel({ NEMOCLAW_TELEMETRY_TEST_LABEL: value })).toBeNull();
    },
  );
  it.each(["qa-shanghai-20261005:linux-docker-openclaw:attempt-1", "qa-campaign:case:attempt-999"])(
    "retains the bounded campaign, case, and attempt label %s",
    (testLabel) => {
      expect(isTelemetryTestLabel(testLabel)).toBe(true);
      expect(
        parseTelemetryEvent({
          event: "nemoclaw_install_completed",
          operation: "install",
          testLabel,
        }),
      ).toEqual({
        event: "nemoclaw_install_completed",
        operation: "install",
        testLabel,
      });
    },
  );

  it.each([
    "",
    "qa-a:b:attempt-0",
    "qa-a:b:attempt-1000",
    "qa-a:b:attempt-01",
    "qa-A:b:attempt-1",
    "qa-a:b:attempt-1\n",
    "qa-private@example.com:b:attempt-1",
    `qa-${"a".repeat(33)}:b:attempt-1`,
    `qa-a:${"b".repeat(41)}:attempt-1`,
    "https://private.invalid",
    null,
  ])("rejects the malformed or unbounded label %j", (testLabel) => {
    expect(isTelemetryTestLabel(testLabel)).toBe(false);
    expect(
      parseTelemetryEvent({ event: "nemoclaw_install_completed", operation: "install", testLabel }),
    ).toBeNull();
  });

  it("validates and copies the label through one property read", () => {
    let reads = 0;
    const value = { event: "nemoclaw_install_completed", operation: "install" };
    Object.defineProperty(value, "testLabel", {
      enumerable: true,
      get: () => (++reads === 1 ? "qa-campaign:case:attempt-1" : "private-identity"),
    });
    expect(parseTelemetryEvent(value)?.testLabel).toBe("qa-campaign:case:attempt-1");
    expect(reads).toBe(1);
  });
});
