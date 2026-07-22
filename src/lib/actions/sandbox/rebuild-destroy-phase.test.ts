// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  listSandboxes: vi.fn(),
  prepareMcpForRebuild: vi.fn(),
  reattachMcpAfterDeleteFailure: vi.fn(),
  removeSandboxRegistryEntryWithReceipt: vi.fn(),
  runOpenshell: vi.fn(),
  stopNimContainer: vi.fn(),
  stopNimContainerByName: vi.fn(),
  waitUntil: vi.fn(),
  warnUnpreservedUserManagedFiles: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("../../core/wait", () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock("../../inference/nim", () => ({
  stopNimContainer: mocks.stopNimContainer,
  stopNimContainerByName: mocks.stopNimContainerByName,
}));

vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
  listSandboxes: mocks.listSandboxes,
}));

vi.mock("./destroy", () => ({
  removeSandboxRegistryEntryWithReceipt: mocks.removeSandboxRegistryEntryWithReceipt,
}));

vi.mock("./rebuild-flow-helpers", () => ({
  warnUnpreservedUserManagedFiles: mocks.warnUnpreservedUserManagedFiles,
}));

vi.mock("./rebuild-mcp-phase", () => ({
  prepareMcpForRebuild: mocks.prepareMcpForRebuild,
  reattachMcpAfterDeleteFailure: mocks.reattachMcpAfterDeleteFailure,
}));

import { runRebuildDestroyPhase } from "./rebuild-destroy-phase";

describe("rebuild destroy phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getSandbox.mockReturnValue(undefined);
    mocks.listSandboxes.mockReturnValue({ sandboxes: [] });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    });
    mocks.reattachMcpAfterDeleteFailure.mockResolvedValue(undefined);
    mocks.removeSandboxRegistryEntryWithReceipt.mockReturnValue(null);
    mocks.waitUntil.mockImplementation(
      (condition: () => boolean) => condition() || condition() || condition(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains unexpected delete-edge diagnostics without logging credentials (#6195)", async () => {
    const secret = `nvapi-${"a".repeat(32)}`;
    const log = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "langchain-deepagents-code" },
        staleRecovery: false,
        backupManifest: null,
        log,
        bail,
        relockShieldsIfNeeded,
        validateAfterMcpPreparation: async () => {
          throw new Error(`route probe failed with ${secret}`);
        },
        onDeleted: vi.fn(),
      }),
    ).rejects.toThrow("DCode replacement validation failed before sandbox deletion.");

    const diagnostics = log.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("Unexpected DCode replacement validation failure");
    expect(diagnostics).toContain("route probe failed");
    expect(diagnostics).toContain("<REDACTED>");
    expect(diagnostics).not.toContain(secret);
    expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledOnce();
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
  });

  it("removes registry state only after the gateway reports the deleted sandbox missing", async () => {
    const events: string[] = [];
    let getAttempts = 0;
    const deleteResult = () => {
      events.push("delete");
      return { status: 0, stdout: "deleted", stderr: "" };
    };
    const getResult = () => {
      getAttempts += 1;
      const isFirstProbe = getAttempts === 1;
      events.push(isFirstProbe ? "get-live" : "get-missing");
      return isFirstProbe
        ? { status: 0, stdout: "Name: alpha\nPhase: Terminating", stderr: "" }
        : { status: 1, stdout: "", stderr: "Error: sandbox alpha not found" };
    };
    mocks.runOpenshell.mockImplementation((args: string[]) =>
      args[1] === "delete" ? deleteResult() : getResult(),
    );
    mocks.removeSandboxRegistryEntryWithReceipt.mockImplementation(() => {
      events.push("remove-registry");
      return null;
    });

    const result = await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw" },
      staleRecovery: false,
      backupManifest: null,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted: vi.fn(() => events.push("on-deleted")),
    });

    expect(result).not.toBeNull();
    expect(events).toEqual(["delete", "get-live", "get-missing", "on-deleted", "remove-registry"]);
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.removeSandboxRegistryEntryWithReceipt).toHaveBeenCalledWith("alpha");
  });

  it("preserves backup and registry state when transport failures prevent deletion confirmation", async () => {
    mocks.runOpenshell.mockImplementation((args: string[]) =>
      args[1] === "delete"
        ? { status: 0, stdout: "deleted", stderr: "" }
        : { status: 1, stdout: "", stderr: "tcp connect error: Connection refused" },
    );
    const onDeleted = vi.fn();

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        backupManifest: { backupPath: "/tmp/rebuild-backups/alpha/backup" } as never,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded: vi.fn(() => true),
        onDeleted,
      }),
    ).rejects.toThrow("Sandbox deletion could not be confirmed.");

    expect(onDeleted).not.toHaveBeenCalled();
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(4);
    expect(mocks.waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ deadlineMs: expect.any(Number) }),
    );
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "  State backup is preserved at: /tmp/rebuild-backups/alpha/backup",
    );
  });
});
