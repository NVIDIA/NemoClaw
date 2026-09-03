// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, type MockInstance } from "vitest";

import { classifyDestroySandboxPresence } from "../../src/lib/actions/sandbox/destroy-presence";
import { type DestroyHarness, sandboxListJson } from "./destroy-flow-test-harness";

export function expectStrictSandboxPresenceClassification(): void {
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

export function expectMcpFinalizeAfterDelete(harness: DestroyHarness): void {
  // The live preparation is force-aware since #10469: `--force` may keep a
  // retained-volume adapter entry that cannot be scrubbed. These flows are all
  // plain destroys, so the flag must be threaded through as false.
  expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalledWith("alpha", { force: false });
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
  expect(harness.events.indexOf("delete")).toBeLessThan(harness.events.indexOf("mcp-restore"));
}

export function expectFailedMcpRestorePreservesDestroyFailure(harness: DestroyHarness): void {
  expect(harness.events).toContain("mcp-restore");
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

export function expectMcpPrepareBridgeErrorAborts(harness: DestroyHarness): void {
  expect(harness.prepareMcpBridgesForDestroySpy).toHaveBeenCalled();
  // No delete should happen when MCP prepare itself throws McpBridgeError.
  expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
    expect.arrayContaining(["sandbox", "delete"]),
    expect.anything(),
  );
  expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
}

export function expectMcpFinalizeBridgeErrorReturnsFailure(
  harness: DestroyHarness,
  secretMarker: string,
): void {
  expect(harness.finalizeMcpBridgesAfterSandboxDeleteSpy).toHaveBeenCalled();
  const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
    (call) => Array.isArray(call[0]) && call[0].join(" ") === "sandbox delete alpha",
  );
  expect(deleteCall).toBeGreaterThanOrEqual(0);
  expect(
    harness.finalizeMcpBridgesAfterSandboxDeleteSpy.mock.invocationCallOrder.at(-1),
  ).toBeGreaterThan(harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall]);
  const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
  expect(errorOutput).not.toContain(secretMarker);
  expect(errorOutput).toContain("<REDACTED>");
  // Registry must not be cleaned up when post-delete MCP finalize throws McpBridgeError.
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
