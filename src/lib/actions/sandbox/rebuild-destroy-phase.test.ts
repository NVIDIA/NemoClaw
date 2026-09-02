// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";

const mocks = vi.hoisted(() => ({
  captureOpenshell: vi.fn(),
  getSandbox: vi.fn(
    (
      _name: string,
    ): {
      name: string;
      agent: string;
      nimContainer?: string | null;
      gatewayName?: string | null;
      gatewayPort?: number | null;
    } | null => null,
  ),
  listSandboxes: vi.fn(() => ({ sandboxes: [] })),
  prepareMcpForRebuild: vi.fn(),
  reattachMcpAfterDeleteFailure: vi.fn(),
  removeSandboxRegistryEntryWithReceipt: vi.fn(() => null),
  waitUntil: vi.fn(),
  warnUnpreservedUserManagedFiles: vi.fn(),
  runOpenshell: vi.fn(
    (
      _args: string[],
    ): {
      status: number | null;
      stdout: string;
      stderr: string;
      error?: NodeJS.ErrnoException;
      signal?: NodeJS.Signals | null;
    } => ({ status: 0, stdout: "", stderr: "" }),
  ),
  stopNimContainer: vi.fn(),
  stopNimContainerByName: vi.fn(),
  settleAgentForwardPortsForRebuild: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureOpenshell: mocks.captureOpenshell,
  runOpenshell: mocks.runOpenshell,
}));

vi.mock("../../core/wait", () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock("../../inference/nim", () => ({
  stopNimContainer: mocks.stopNimContainer,
  stopNimContainerByName: mocks.stopNimContainerByName,
}));

vi.mock("../../tunnel/agent-forward-stop", () => ({
  settleAgentForwardPortsForRebuild: mocks.settleAgentForwardPortsForRebuild,
}));

vi.mock("../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/registry")>()),
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

import { runRebuildDestroyPhase, waitForRebuildDeleteAbsence } from "./rebuild-destroy-phase";
import type { RebuildRecreateJournal } from "./rebuild-recreate-journal";

function stubRecreateJournal(): RebuildRecreateJournal {
  return {
    id: "journal-1",
    acceptedTarget: false,
    sourceConfirmedAbsent: false,
    gatewayAuthority: {
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    },
    targetGeneration: "generation-1",
    targetIntentFingerprint: "intent-1",
    beginDelete: vi.fn(() => "source" as const),
    confirmDeleted: vi.fn(),
    completeAcceptedTarget: vi.fn(),
  };
}

describe("rebuild destroy phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
    });
    mocks.listSandboxes.mockReturnValue({ sandboxes: [] });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
    });
    mocks.reattachMcpAfterDeleteFailure.mockResolvedValue(undefined);
    mocks.removeSandboxRegistryEntryWithReceipt.mockReturnValue(null);
    mocks.captureOpenshell.mockReturnValue({
      status: 1,
      output: "",
      stdout: "",
      stderr: "Error: sandbox alpha not found",
    });
    mocks.runOpenshell.mockImplementation((args: string[]) =>
      args[1] === "get"
        ? { status: 1, stdout: "", stderr: "Error: sandbox alpha not found" }
        : { status: 0, stdout: "", stderr: "" },
    );
    mocks.waitUntil.mockImplementation(
      (condition: () => boolean) => condition() || condition() || condition(),
    );
    mocks.settleAgentForwardPortsForRebuild.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
        recreateJournal: stubRecreateJournal(),
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

  it("blocks the exact delete edge when the shared inference route drifts (#7798)", async () => {
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: null,
        log: vi.fn(),
        bail,
        relockShieldsIfNeeded: vi.fn(() => true),
        validateAtDeleteEdge: () => ({
          ok: false,
          message: "Shared inference route changed before sandbox deletion.",
        }),
        onDeleted: vi.fn(),
      }),
    ).rejects.toThrow("Shared inference route changed before sandbox deletion.");

    expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledOnce();
    expectNoSandboxDelete(mocks.runOpenshell);
  });

  it("passes force=true to prepareMcpForRebuild when input.force is set (#7062)", async () => {
    const log = vi.fn();
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw" },
      staleRecovery: false,
      recreateJournal: stubRecreateJournal(),
      backupManifest: null,
      force: true,
      log,
      bail,
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted: vi.fn(),
    });

    expect(mocks.prepareMcpForRebuild).toHaveBeenCalledWith(
      "alpha",
      false,
      true,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("removes a legacy Docker orphan after confirmed OpenShell deletion and before recreation", async () => {
    const recreateJournal = stubRecreateJournal();
    const cleanupDockerOrphanAfterDelete = vi.fn();
    const onDeleted = vi.fn();

    await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw" },
      staleRecovery: false,
      recreateJournal,
      backupManifest: null,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded: vi.fn(() => true),
      cleanupDockerOrphanAfterDelete,
      onDeleted,
    });

    expect(recreateJournal.confirmDeleted).toHaveBeenCalledOnce();
    expect(cleanupDockerOrphanAfterDelete).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(vi.mocked(recreateJournal.confirmDeleted).mock.invocationCallOrder[0]).toBeLessThan(
      cleanupDockerOrphanAfterDelete.mock.invocationCallOrder[0]!,
    );
    expect(cleanupDockerOrphanAfterDelete.mock.invocationCallOrder[0]).toBeLessThan(
      onDeleted.mock.invocationCallOrder[0]!,
    );
  });

  it("retains the deleted recovery boundary when Docker orphan cleanup fails", async () => {
    const recreateJournal = stubRecreateJournal();
    const onDeleted = vi.fn();

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        recreateJournal,
        backupManifest: null,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded: vi.fn(() => true),
        cleanupDockerOrphanAfterDelete: () => {
          throw new Error("container removal refused");
        },
        onDeleted,
      }),
    ).rejects.toThrow("Post-delete Docker orphan cleanup failed: container removal refused");

    expect(recreateJournal.confirmDeleted).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("pins deletion to the recorded gateway when ambient selection changes (#7062)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "nemoclaw-29080");
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw-19080",
      gatewayPort: 19080,
    });

    await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw-19080",
        gatewayPort: 19080,
      },
      staleRecovery: false,
      recreateJournal: stubRecreateJournal(),
      backupManifest: null,
      force: true,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted: vi.fn(),
    });

    expect(mocks.runOpenshell).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw-19080", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it.each([
    [
      "sandbox name",
      {
        name: "beta",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      },
    ],
    [
      "gateway binding",
      {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw-29080",
        gatewayPort: 29080,
      },
    ],
  ])(
    "refuses deletion when the registry %s changes before MCP preparation (#7062)",
    async (_label, currentEntry) => {
      mocks.getSandbox.mockReturnValue(currentEntry);
      mocks.prepareMcpForRebuild.mockResolvedValue({
        entries: [{ server: "github" }],
        detachedProviderEntries: [{ server: "github" }],
        scrubbedAdapterEntries: [],
      });
      const relockShieldsIfNeeded = vi.fn(() => true);

      await expect(
        runRebuildDestroyPhase({
          sandboxName: "alpha",
          sandboxEntry: {
            name: "alpha",
            agent: "openclaw",
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
          },
          staleRecovery: false,
          recreateJournal: stubRecreateJournal(),
          backupManifest: null,
          force: true,
          log: vi.fn(),
          bail: vi.fn((message: string): never => {
            throw new Error(message);
          }),
          relockShieldsIfNeeded,
          onDeleted: vi.fn(),
        }),
      ).rejects.toThrow("Sandbox delete target changed during rebuild preparation.");

      expect(mocks.getSandbox).toHaveBeenCalledTimes(2);
      expect(mocks.prepareMcpForRebuild.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.getSandbox.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
      );
      expect(mocks.runOpenshell).not.toHaveBeenCalled();
      expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledWith(
        "alpha",
        [{ server: "github" }],
        [],
      );
      expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
      expect(mocks.stopNimContainer).not.toHaveBeenCalled();
      expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
      expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
    },
  );

  it("refuses sandbox deletion and invokes recovery when MCP state drifts at the delete edge", async () => {
    const revalidateBeforeDelete = vi.fn().mockRejectedValue(new Error("live policy drifted"));
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{}],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      revalidateBeforeDelete,
    });
    const relockShieldsIfNeeded = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail,
        relockShieldsIfNeeded,
        onDeleted: vi.fn(),
      }),
    ).rejects.toThrow(
      "Failed to revalidate MCP recovery before sandbox deletion: live policy drifted",
    );

    expect(revalidateBeforeDelete).toHaveBeenCalledOnce();
    expect(mocks.runOpenshell).not.toHaveBeenCalled();
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledWith("alpha", [], []);
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
  });

  it("retains read-only MCP ownership when sandbox deletion fails (#7062)", async () => {
    const revalidateBeforeDelete = vi.fn().mockResolvedValue(undefined);
    const entry = { server: "github" };
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [entry],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      revalidateBeforeDelete,
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete failed" })
      .mockReturnValueOnce({ status: 0, stdout: "Phase: Ready\n", stderr: "" });
    const onDeleted = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail,
        relockShieldsIfNeeded,
        onDeleted,
      }),
    ).rejects.toThrow("Failed to delete sandbox.");

    expect(revalidateBeforeDelete).toHaveBeenCalledOnce();
    expect(revalidateBeforeDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOpenshell.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledWith("alpha", [], []);
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
    expect(mocks.runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.any(Object),
    );
  });

  it("converges as deleted when a nonzero delete is followed by exact NotFound (#7062)", async () => {
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [{ server: "github" }],
      scrubbedAdapterEntries: [],
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete interrupted" })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: 'status: Internal, message: "sandbox has no spec"',
      });
    const onDeleted = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);

    const result = await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
      staleRecovery: false,
      recreateJournal: stubRecreateJournal(),
      backupManifest: null,
      force: true,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded,
      onDeleted,
    });

    expect(result?.entries).toEqual([{ server: "github" }]);
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(mocks.stopNimContainerByName).toHaveBeenCalledWith("nim-alpha");
    expect(mocks.reattachMcpAfterDeleteFailure).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).not.toHaveBeenCalled();
  });

  it.each([
    [
      "bare NotFound output",
      {
        status: 1,
        stdout: "",
        stderr: "NotFound",
      },
    ],
    [
      "generic sandbox NotFound output",
      {
        status: 1,
        stdout: "",
        stderr: 'status: NotFound, message: "sandbox not found"',
      },
    ],
    [
      "gateway NotFound output",
      {
        status: 1,
        stdout: "",
        stderr: 'status: NotFound, message: "gateway nemoclaw not found"',
      },
    ],
    [
      "provider NotFound output",
      {
        status: 1,
        stdout: "",
        stderr: 'status: NotFound, message: "provider alpha-mcp-github not found"',
      },
    ],
    [
      "signal-terminated sandbox absence output",
      {
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: 'status: Internal, message: "sandbox has no spec"',
      },
    ],
    [
      "null-status sandbox absence output",
      {
        status: null,
        signal: null,
        stdout: "",
        stderr: 'status: Internal, message: "sandbox has no spec"',
      },
    ],
    [
      "mixed gateway and sandbox absence output",
      {
        status: 1,
        stdout: "",
        stderr:
          'status: NotFound, message: "gateway nemoclaw not found"\nstatus: Internal, message: "sandbox has no spec"',
      },
    ],
    [
      "absence output for a different sandbox",
      {
        status: 1,
        stdout: "",
        stderr: "sandbox beta not found",
      },
    ],
  ] satisfies ReadonlyArray<
    readonly [
      string,
      {
        status: number | null;
        signal?: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      },
    ]
  >)("does not treat %s as proof of sandbox deletion (#7062)", async (_label, probe) => {
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [{ server: "github" }],
      scrubbedAdapterEntries: [],
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete interrupted" })
      .mockReturnValueOnce(probe);
    const onDeleted = vi.fn();
    const onDeleteStateAmbiguous = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded,
        onDeleted,
        onDeleteStateAmbiguous,
      }),
    ).rejects.toThrow(/exact post-delete state is ambiguous.*recovery state was preserved/i);

    expect(onDeleted).not.toHaveBeenCalled();
    expect(onDeleteStateAmbiguous).toHaveBeenCalledOnce();
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(mocks.reattachMcpAfterDeleteFailure).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).not.toHaveBeenCalled();
  });

  it("preserves recovery ownership when post-delete state is partial or ambiguous (#7062)", async () => {
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [{ server: "github" }],
      scrubbedAdapterEntries: [],
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete interrupted" })
      .mockReturnValueOnce({ status: 0, stdout: "Phase: Terminating\n", stderr: "" });
    const onDeleted = vi.fn();
    const onDeleteStateAmbiguous = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded,
        onDeleted,
        onDeleteStateAmbiguous,
      }),
    ).rejects.toThrow(/exact post-delete state is ambiguous.*recovery state was preserved/i);

    expect(onDeleted).not.toHaveBeenCalled();
    expect(onDeleteStateAmbiguous).toHaveBeenCalledOnce();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(mocks.reattachMcpAfterDeleteFailure).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).not.toHaveBeenCalled();
  });

  it("does not treat missing-looking partial output from a timed-out probe as deleted (#7062)", async () => {
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [{ server: "github" }],
      scrubbedAdapterEntries: [],
    });
    mocks.runOpenshell
      .mockReturnValueOnce({ status: 9, stdout: "", stderr: "delete interrupted" })
      .mockReturnValueOnce({
        status: null,
        stdout: "",
        stderr: 'status: Internal, message: "sandbox has no spec"',
        error: Object.assign(new Error("probe timed out"), { code: "ETIMEDOUT" }),
      });
    const onDeleted = vi.fn();
    const onDeleteStateAmbiguous = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: null,
        force: true,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded,
        onDeleted,
        onDeleteStateAmbiguous,
      }),
    ).rejects.toThrow(/exact post-delete state is ambiguous.*recovery state was preserved/i);

    expect(mocks.runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onDeleteStateAmbiguous).toHaveBeenCalledOnce();
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(mocks.reattachMcpAfterDeleteFailure).not.toHaveBeenCalled();
    expect(relockShieldsIfNeeded).not.toHaveBeenCalled();
  });

  it("stops local NIM only after a read-only MCP rebuild deletes the sandbox (#7062)", async () => {
    const revalidateBeforeDelete = vi.fn().mockResolvedValue(undefined);
    const assertDeleteEdgeUnchanged = vi.fn();
    mocks.getSandbox.mockReturnValueOnce({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [],
      scrubbedAdapterEntries: [],
      revalidateBeforeDelete,
      assertDeleteEdgeUnchanged,
    });

    await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw" },
      staleRecovery: false,
      recreateJournal: stubRecreateJournal(),
      backupManifest: null,
      force: true,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted: vi.fn(),
    });

    expect(revalidateBeforeDelete).toHaveBeenCalledOnce();
    expect(assertDeleteEdgeUnchanged).toHaveBeenCalledOnce();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).toHaveBeenCalledWith("nim-alpha");
    expect(assertDeleteEdgeUnchanged.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOpenshell.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.runOpenshell.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stopNimContainerByName.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("bounds delete convergence without treating timeout or gateway errors as absence (#7194)", async () => {
    const { waitUntil: realWaitUntil } =
      await vi.importActual<typeof import("../../core/wait")>("../../core/wait");
    mocks.waitUntil.mockImplementation(realWaitUntil);

    let currentMs = 0;
    let attempts = 0;
    const timeout = Object.assign(new Error("sandbox get timed out"), { code: "ETIMEDOUT" });
    const probeFailures = [
      { status: null, error: timeout },
      { status: 1, stderr: "gateway transport unavailable" },
      { status: 1, stderr: 'status: NotFound, message: "gateway not found"' },
    ];
    const captureSandboxGet = vi.fn(() => {
      const failure = probeFailures[attempts % probeFailures.length];
      attempts += 1;
      return failure;
    });
    const sleep = vi.fn((milliseconds: number) => {
      currentMs += milliseconds;
    });

    expect(
      waitForRebuildDeleteAbsence("alpha", "nemoclaw", vi.fn(), {
        captureSandboxGet,
        now: () => currentMs,
        sleep,
      }),
    ).toBe(false);

    expect(captureSandboxGet.mock.calls.length).toBeGreaterThan(1);
    expect(captureSandboxGet.mock.calls.length).toBeLessThanOrEqual(20);
    expect(sleep).toHaveBeenCalled();
    expect(currentMs).toBeLessThanOrEqual(15_000);
  });

  it("recognizes the exact structured OpenShell sandbox-absence response (#7062)", () => {
    const log = vi.fn();

    expect(
      waitForRebuildDeleteAbsence("alpha", "nemoclaw", log, {
        captureSandboxGet: vi.fn(() => ({
          status: 1,
          stdout: "",
          stderr:
            "Error:   × code: 'Some requested entity was not found', message: \"sandbox not found\"",
        })),
      }),
    ).toBe(true);

    expect(log).toHaveBeenCalledWith("Delete convergence probe 1: status=1, state=absent");
  });

  it.each([
    ["another sandbox", { status: 1, stderr: "sandbox beta not found" }],
    [
      "a missing gateway",
      { status: 1, stderr: 'status: NotFound, message: "gateway nemoclaw not found"' },
    ],
    [
      "a missing provider",
      { status: 1, stderr: 'status: NotFound, message: "provider alpha-mcp-github not found"' },
    ],
    [
      "a structured missing gateway",
      {
        status: 1,
        stderr:
          "Error:   × code: 'Some requested entity was not found', message: \"gateway not found\"",
      },
    ],
    [
      "a structured missing provider",
      {
        status: 1,
        stderr:
          "Error:   × code: 'Some requested entity was not found', message: \"provider not found\"",
      },
    ],
    [
      "mixed gateway and sandbox diagnostics",
      {
        status: 1,
        stderr:
          'status: NotFound, message: "gateway nemoclaw not found"\nstatus: Internal, message: "sandbox has no spec"',
      },
    ],
    [
      "a signal-terminated probe with a missing-sandbox diagnostic",
      {
        status: 1,
        signal: "SIGTERM" as NodeJS.Signals,
        stderr: "Error: sandbox alpha not found",
      },
    ],
  ])("does not continue deletion after convergence reports %s", async (_label, probe) => {
    mocks.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "openclaw",
      nimContainer: "nim-alpha",
    });
    mocks.runOpenshell.mockReturnValue({ status: 0, stdout: "deleted", stderr: "" });
    mocks.captureOpenshell.mockReturnValue({
      stdout: "",
      ...probe,
    });
    const onDeleted = vi.fn();

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: null,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded: vi.fn(() => true),
        onDeleted,
      }),
    ).rejects.toThrow("Sandbox deletion could not be confirmed.");

    expect(onDeleted).not.toHaveBeenCalled();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
  });

  it("keeps the journaled source row after the gateway reports the deleted sandbox missing (#7734)", async () => {
    const events: string[] = [];
    let getAttempts = 0;
    mocks.runOpenshell.mockImplementation(() => {
      events.push("delete");
      return { status: 0, stdout: "deleted", stderr: "" };
    });
    mocks.captureOpenshell.mockImplementation(() => {
      getAttempts += 1;
      const isFirstProbe = getAttempts === 1;
      events.push(isFirstProbe ? "get-live" : "get-missing");
      return isFirstProbe
        ? { status: 0, stdout: "Name: alpha\nPhase: Terminating", stderr: "" }
        : { status: 1, stdout: "", stderr: "Error: sandbox alpha not found" };
    });
    const recreateJournal = stubRecreateJournal();

    const result = await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
      staleRecovery: false,
      recreateJournal,
      backupManifest: null,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted: vi.fn(() => events.push("on-deleted")),
    });

    expect(result).not.toBeNull();
    expect(result?.removalReceipt).toBeNull();
    expect(events).toEqual(["delete", "get-live", "get-missing", "on-deleted"]);
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.captureOpenshell).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(recreateJournal.beginDelete).toHaveBeenCalledOnce();
    expect(recreateJournal.confirmDeleted).toHaveBeenCalledOnce();
  });

  it("journals the delete boundary before the destructive command (#7734)", async () => {
    const order: string[] = [];
    const recreateJournal = stubRecreateJournal();
    mocks.settleAgentForwardPortsForRebuild.mockImplementation(() => {
      order.push("forward:stop");
      return true;
    });
    vi.mocked(recreateJournal.beginDelete).mockImplementation(() => {
      order.push("journal:deleting");
      return "source";
    });
    mocks.runOpenshell.mockImplementation((args: string[]) => {
      const deleting = args[1] === "delete";
      order.push(...(deleting ? ["openshell:delete"] : []));
      return deleting
        ? { status: 0, stdout: "deleted", stderr: "" }
        : { status: 1, stdout: "", stderr: "Error: sandbox alpha not found" };
    });

    await runRebuildDestroyPhase({
      sandboxName: "alpha",
      sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
      staleRecovery: false,
      recreateJournal,
      backupManifest: null,
      log: vi.fn(),
      bail: vi.fn((message: string): never => {
        throw new Error(message);
      }),
      relockShieldsIfNeeded: vi.fn(() => true),
      onDeleted: vi.fn(),
    });

    expect(order).toEqual(["forward:stop", "journal:deleting", "openshell:delete", "forward:stop"]);
  });

  it("reattaches MCP providers when the delete boundary cannot be journaled (#7734)", async () => {
    const recreateJournal = stubRecreateJournal();
    vi.mocked(recreateJournal.beginDelete).mockImplementation(() => {
      throw new Error("session store is unwritable");
    });
    mocks.prepareMcpForRebuild.mockResolvedValue({
      entries: [{ server: "github" }],
      detachedProviderEntries: [{ providerName: "nemoclaw-mcp-alpha-github" }],
      scrubbedAdapterEntries: [{ server: "github" }],
    });
    const relockShieldsIfNeeded = vi.fn(() => true);

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        recreateJournal,
        backupManifest: null,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded,
        onDeleted: vi.fn(),
      }),
    ).rejects.toThrow("Sandbox deletion could not be journaled");

    expect(mocks.reattachMcpAfterDeleteFailure).toHaveBeenCalledWith(
      "alpha",
      [{ providerName: "nemoclaw-mcp-alpha-github" }],
      [{ server: "github" }],
    );
    expect(relockShieldsIfNeeded).toHaveBeenCalledWith(true);
    expect(mocks.runOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.anything(),
    );
  });

  it("stops before inference and registry mutation when absence cannot be journaled (#7734)", async () => {
    const recreateJournal = stubRecreateJournal();
    vi.mocked(recreateJournal.confirmDeleted).mockImplementation(() => {
      throw new Error("OpenShell still reports the journaled source after delete");
    });
    mocks.runOpenshell.mockReturnValue({ status: 0, stdout: "deleted", stderr: "" });
    const onDeleted = vi.fn();
    const onDeleteStateAmbiguous = vi.fn();

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        recreateJournal,
        backupManifest: null,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded: vi.fn(() => true),
        onDeleted,
        onDeleteStateAmbiguous,
      }),
    ).rejects.toThrow("Sandbox deletion could not be journaled");

    expect(onDeleteStateAmbiguous).toHaveBeenCalledOnce();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(mocks.stopNimContainer).not.toHaveBeenCalled();
    expect(mocks.stopNimContainerByName).not.toHaveBeenCalled();
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
  });

  it("marks accepted deletion as ambiguous when transport failures prevent confirmation", async () => {
    mocks.runOpenshell.mockReturnValue({ status: 0, stdout: "deleted", stderr: "" });
    mocks.captureOpenshell.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "tcp connect error: Connection refused",
    });
    const onDeleted = vi.fn();
    const onDeleteStateAmbiguous = vi.fn();
    const relockShieldsIfNeeded = vi.fn(() => true);

    await expect(
      runRebuildDestroyPhase({
        sandboxName: "alpha",
        sandboxEntry: { name: "alpha", agent: "openclaw", gatewayName: "nemoclaw" },
        staleRecovery: false,
        recreateJournal: stubRecreateJournal(),
        backupManifest: { backupPath: "/tmp/rebuild-backups/alpha/backup" } as never,
        log: vi.fn(),
        bail: vi.fn((message: string): never => {
          throw new Error(message);
        }),
        relockShieldsIfNeeded,
        onDeleted,
        onDeleteStateAmbiguous,
      }),
    ).rejects.toThrow("Sandbox deletion could not be confirmed.");

    expect(onDeleted).not.toHaveBeenCalled();
    expect(onDeleteStateAmbiguous).toHaveBeenCalledOnce();
    expect(relockShieldsIfNeeded).not.toHaveBeenCalled();
    expect(mocks.runOpenshell).toHaveBeenCalledTimes(1);
    expect(mocks.captureOpenshell).toHaveBeenCalledTimes(3);
    expect(mocks.waitUntil).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ deadlineMs: expect.any(Number), maxAttempts: 20 }),
    );
    expect(mocks.removeSandboxRegistryEntryWithReceipt).not.toHaveBeenCalled();
    expect(mocks.listSandboxes).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "  State backup is preserved at: /tmp/rebuild-backups/alpha/backup",
    );
  });
});
