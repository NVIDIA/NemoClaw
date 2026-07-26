// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, type MockInstance } from "vitest";

import {
  type DestroyHarness,
  loadDestroySandboxPresenceClassifier,
  sandboxListJson,
} from "./destroy-flow-test-harness";

export function expectStrictSandboxPresenceClassification(): void {
  const classifyDestroySandboxPresence = loadDestroySandboxPresenceClassifier();
  expect(
    classifyDestroySandboxPresence("alpha", {
      status: 0,
      stdout: sandboxListJson(["alpha"]),
    }),
  ).toBe("present");
  expect(
    classifyDestroySandboxPresence("alpha", {
      status: 0,
      stdout: sandboxListJson(["beta"]),
    }),
  ).toBe("absent");
  expect(
    classifyDestroySandboxPresence("alpha", {
      status: 1,
      stderr: "gateway unavailable",
    }),
  ).toBe("unknown");
  expect(
    classifyDestroySandboxPresence("alpha", {
      status: 0,
      stdout: "arbitrary warning text",
    }),
  ).toBe("unknown");
  expect(
    classifyDestroySandboxPresence("alpha", {
      status: 0,
      stdout: JSON.stringify([{ name: "beta" }]),
    }),
  ).toBe("unknown");
  expect(
    classifyDestroySandboxPresence("alpha", {
      status: 0,
      stdout: "",
    }),
  ).toBe("unknown");
}

export function expectSuccessfulLiveDestroy(harness: DestroyHarness, exitSpy: MockInstance): void {
  expect(harness.selectGatewaySpy).toHaveBeenCalledWith(
    "alpha",
    "nemoclaw-19080",
    harness.runOpenshellSpy,
  );
  expect(harness.gatewayPinsAtSandboxList).toEqual(["nemoclaw-19080"]);
  expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
    ["sandbox", "list", "-o", "json"],
    expect.objectContaining({ ignoreError: true }),
  );
  expect(harness.stopNimByNameSpy).toHaveBeenCalledWith("alpha-nim");
  expect(harness.killStaleProxySpy).toHaveBeenCalledTimes(1);
  expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
    ["sandbox", "delete", "alpha"],
    expect.objectContaining({ ignoreError: true }),
  );
  expect(harness.unloadOllamaModelsSpy).toHaveBeenCalledTimes(1);
  expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith("nemoclaw-19080", harness.runOpenshellSpy);
  expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
    "Sandbox 'alpha' destroyed",
  );
  expect(exitSpy).not.toHaveBeenCalled();
}

export function expectFailedDeletePreservesHostState(
  harness: DestroyHarness,
  exitSpy: MockInstance,
): void {
  expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
    ["sandbox", "delete", "alpha"],
    expect.objectContaining({ ignoreError: true }),
  );
  expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
  expect(exitSpy).toHaveBeenCalledWith(7);
}

export function expectShieldsUpRefusalBeforeMutation(harness: DestroyHarness): void {
  expect(harness.stopNimByNameSpy).not.toHaveBeenCalled();
  expect(harness.killStaleProxySpy).not.toHaveBeenCalled();
  expect(harness.selectGatewaySpy).toHaveBeenCalledWith(
    "alpha",
    "nemoclaw-19080",
    harness.runOpenshellSpy,
  );
  expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
  expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
    ["sandbox", "list", "-o", "json"],
    expect.objectContaining({ ignoreError: true }),
  );
}

export function expectActiveTimerDestroyOrder(harness: DestroyHarness): void {
  expect(harness.events).toEqual(
    expect.arrayContaining(["wipe", "harden", "detach", "delete", "timer-cleanup"]),
  );
  expect(harness.events.indexOf("wipe")).toBeLessThan(harness.events.indexOf("harden"));
  expect(harness.events.indexOf("harden")).toBeLessThan(harness.events.indexOf("delete"));
  expect(harness.events.indexOf("delete")).toBeLessThan(harness.events.indexOf("timer-cleanup"));
}

export function expectFailedHardeningStopsDelete(harness: DestroyHarness): void {
  expect(harness.events).toContain("wipe");
  expect(harness.events).toContain("harden");
  expect(harness.events).not.toContain("delete");
  expect(harness.killTimerSpy).not.toHaveBeenCalled();
}

export function expectMcpFinalizeAfterDelete(harness: DestroyHarness): void {
  expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalledWith("alpha");
  expect(harness.gatewayPinsAtMcpPrepare).toEqual(["nemoclaw-19080"]);
  const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
    (call) => Array.isArray(call[0]) && call[0].join(" ") === "sandbox delete alpha",
  );
  expect(deleteCall).toBeGreaterThanOrEqual(0);
  expect(harness.prepareMcpBridgesForDestroySpy.mock.invocationCallOrder.at(-1)).toBeLessThan(
    harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall],
  );
  expect(
    harness.finalizeMcpBridgesAfterSandboxDeleteSpy.mock.invocationCallOrder.at(-1),
  ).toBeGreaterThan(harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall]);
  expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledWith(
    "alpha",
    expect.objectContaining({
      entries: [{ server: "github" }, { server: "slack" }],
    }),
    { force: false },
  );
  expect(harness.restoreMcpBridgesAfterDestroyAbortSpy).not.toHaveBeenCalled();
}

export function expectMcpRestoreAfterDeleteFailure(harness: DestroyHarness): void {
  expect(harness.restoreMcpBridgesAfterDestroyAbortSpy).toHaveBeenCalledWith(
    "alpha",
    expect.objectContaining({ entries: [{ server: "github" }] }),
  );
  expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).not.toHaveBeenCalled();
  expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  expect(harness.events.filter((event) => event === "harden")).toHaveLength(2);
  expect(harness.events.indexOf("delete")).toBeLessThan(harness.events.indexOf("unlock"));
  expect(harness.events.indexOf("unlock")).toBeLessThan(harness.events.indexOf("mcp-restore"));
  expect(harness.events.indexOf("mcp-restore")).toBeLessThan(harness.events.lastIndexOf("harden"));
  expect(harness.shieldsDownSpy).toHaveBeenCalledWith(
    "alpha",
    expect.objectContaining({
      timeout: "15m",
      deferAutoRestoreWhileOwnerAlive: true,
      processToken: "a".repeat(32),
      throwOnError: true,
    }),
  );
  expect(harness.shieldsDownSpy.mock.calls[0]?.[1]).not.toHaveProperty("skipTimer");
}

export function expectFailedMcpRestorePreservesDestroyFailure(harness: DestroyHarness): void {
  expect(harness.events.filter((event) => event === "harden")).toHaveLength(2);
  expect(harness.events.indexOf("mcp-restore")).toBeLessThan(harness.events.lastIndexOf("harden"));
  expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
}

export function expectFailedMcpFinalizePreservesRegistry(harness: DestroyHarness): void {
  expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledWith(
    "alpha",
    expect.any(Object),
    { force: true },
  );
  expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
}

export function expectAbsentSandboxMcpFinalize(harness: DestroyHarness): void {
  expect(harness.prepareMcpBridgesForDestroySpy).not.toHaveBeenCalled();
  expect(harness.prepareMcpBridgesForAbsentSandboxDestroySpy).toHaveBeenCalledWith("alpha", {
    force: false,
  });
  expect(harness.gatewayPinsAtMcpPrepare).toEqual(["nemoclaw-19080"]);
  expect(harness.restoreMcpBridgesAfterDestroyAbortSpy).not.toHaveBeenCalled();
  expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalledWith(
    "alpha",
    expect.objectContaining({ entries: [{ server: "github" }] }),
    { force: false },
  );
  expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
}
