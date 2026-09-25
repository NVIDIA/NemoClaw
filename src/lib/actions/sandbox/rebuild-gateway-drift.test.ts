// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as gatewayDrift from "../../adapters/openshell/gateway-drift";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as gatewaySelection from "./gateway-select";
import * as gatewayState from "./gateway-state";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as registry from "../../state/registry";
import * as crossPortRegistry from "../../state/registry/cross-port";
import * as registryPersistence from "../../state/registry/persistence";
import { type RebuildSandboxEntry, resolveRebuildLiveState } from "./rebuild-flow-helpers";
import {
  checkRebuildGatewaySchemaPreflight,
  runRebuildGatewayIntentPreflight,
} from "./rebuild-preflight-guards";
import {
  delegateRecoveryRetirementToOwningRegistry,
  delegateRebuildToOwningRegistry,
  findRebuildRecoveryStorageRoot,
  rebuildOwningRegistryDependencies,
} from "./rebuild/owning-registry";
import { rebuildSandbox } from "./rebuild";

const driftIssue: gatewayDrift.OpenShellStateRpcIssue = {
  kind: "image_drift",
  drift: {
    containerName: "openshell-cluster-nemoclaw",
    currentImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
    currentVersion: "0.0.36",
    expectedVersion: "0.0.37",
  },
};

const recoveryStates = [
  "missing_named",
  "named_unhealthy",
  "named_unreachable",
  "connected_other",
] as const;

function makeSandboxEntry(gatewayName = "nemoclaw", gatewayPort = 8080): RebuildSandboxEntry {
  return {
    name: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    nimContainer: null,
    agent: null,
    nemoclawVersion: "0.1.0",
    dashboardPort: 18789,
    gatewayName,
    gatewayPort,
  };
}

function bail(message: string): never {
  throw new Error(message);
}

describe("rebuild gateway drift preflight", () => {
  let captureOpenshellSpy: MockInstance;
  let recoverNamedGatewayRuntimeSpy: MockInstance;
  let getNamedGatewayLifecycleStateSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeEach(() => {
    vi.spyOn(gatewaySelection, "selectSandboxOwningGateway").mockImplementation(async (name) => ({
      outcome: "selected",
      gatewayName: registry.getSandbox(name)?.gatewayName ?? "nemoclaw",
    }));

    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockResolvedValue(null);
    vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockResolvedValue(null);
    vi.spyOn(gatewayDrift, "printOpenShellStateRpcIssue").mockImplementation(() => undefined);
    captureOpenshellSpy = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "alpha Ready" });
    vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0, output: "" } as never);
    recoverNamedGatewayRuntimeSpy = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({
        recovered: true,
        attempted: true,
        before: { state: "healthy_named" },
        after: { state: "healthy_named" },
      } as never);
    getNamedGatewayLifecycleStateSpy = vi
      .spyOn(gatewayRuntime, "getNamedGatewayLifecycleState")
      .mockResolvedValue({
        state: "healthy_named",
        activeGateway: "nemoclaw",
        status: "",
      } as never);
    vi.spyOn(registry, "getSandbox").mockReturnValue(makeSandboxEntry() as never);
    vi.spyOn(crossPortRegistry, "findSandboxAcrossGatewayRoots").mockImplementation(
      (name: string) => {
        const entry = registry.getSandbox(name);
        return entry
          ? { entry, gatewayPort: entry.gatewayPort ?? null, registryFile: "/test/sandboxes.json" }
          : null;
      },
    );
    vi.spyOn(registryPersistence, "load").mockReturnValue({
      sandboxes: { alpha: makeSandboxEntry() },
    } as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports failed gateway observation without claiming a sibling is active", async () => {
    captureOpenshellSpy.mockReturnValue({ status: 0, output: "beta Ready" });
    vi.spyOn(gatewayState, "getReconciledSandboxGatewayState").mockResolvedValue({
      state: "present",
      output: "alpha Ready",
    });
    const observation = {
      state: "observation_failed" as const,
      activeGateway: null,
      diagnostic: "Gateway observation could not be completed.",
      recoveryBlocked: true,
      unavailable: true,
    };
    getNamedGatewayLifecycleStateSpy.mockResolvedValue(observation);
    const wrongGateway = vi.spyOn(gatewayState, "printWrongGatewayActiveGuidance");

    await expect(
      resolveRebuildLiveState("alpha", makeSandboxEntry(), vi.fn(), bail),
    ).rejects.toThrow("(observation_failed)");
    expect(errorSpy).toHaveBeenCalledWith(observation.diagnostic);
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain(
      "currently active OpenShell gateway",
    );
    expect(wrongGateway).not.toHaveBeenCalled();
  });

  it("rejects gateway image drift before confirming rebuild intent", async () => {
    vi.mocked(gatewayDrift.detectOpenShellStateRpcPreflightIssue).mockResolvedValue(driftIssue);
    const confirmIntent = vi.fn();

    await expect(
      runRebuildGatewayIntentPreflight({
        checkGatewaySchema: () =>
          checkRebuildGatewaySchemaPreflight("alpha", makeSandboxEntry(), bail),
        confirmIntent,
      }),
    ).rejects.toThrow("OpenShell gateway schema mismatch.");

    expect(gatewayDrift.detectOpenShellStateRpcPreflightIssue).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
    });
    expect(gatewayDrift.printOpenShellStateRpcIssue).toHaveBeenCalledWith(driftIssue, {
      action: "rebuilding sandbox 'alpha'",
      command: "nemoclaw alpha rebuild",
    });
    expect(confirmIntent).not.toHaveBeenCalled();
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
  });

  it("binds gateway schema preflight to the frozen runtime target (#10514)", async () => {
    const runtimeSelection = {
      gatewayName: "nemoclaw",
      localTlsDir: "/authority/tls",
      workspace: "default",
    };

    expect(
      await checkRebuildGatewaySchemaPreflight("alpha", makeSandboxEntry(), bail, runtimeSelection),
    ).toBe(true);
    expect(gatewayDrift.detectOpenShellStateRpcPreflightIssue).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      runtimeSelection,
    });
  });

  it("prints the safe-abort diagnostic before bailing on gateway schema drift (#7794)", async () => {
    vi.mocked(gatewayDrift.detectOpenShellStateRpcPreflightIssue).mockResolvedValue(driftIssue);
    const nonThrowingBail = vi.fn();

    expect(
      await checkRebuildGatewaySchemaPreflight(
        "alpha",
        makeSandboxEntry(),
        nonThrowingBail as never,
      ),
    ).toBe(false);

    const diagnostics = errorSpy.mock.calls.flat().join("\n");
    expect(diagnostics).toContain("Rebuild preflight failed:");
    expect(diagnostics).toContain("OpenShell gateway schema is incompatible with this rebuild.");
    expect(diagnostics).toContain("Follow the gateway recovery guidance above");
    expect(diagnostics).toContain("Aborting rebuild — sandbox is untouched, no data was lost.");
    expect(nonThrowingBail).toHaveBeenCalledWith("OpenShell gateway schema mismatch.");
  });

  it.each([
    {
      recordedGateway: "nemoclaw",
      recordedPort: 8080,
      activeGateway: "other-gw",
    },
    {
      recordedGateway: "nemoclaw-9000",
      recordedPort: 9000,
      activeGateway: "nemoclaw",
    },
  ])(
    "refuses missing $recordedGateway even while $activeGateway is ambiently active, after the gateway-pinned lookup (#4497)",
    async ({ recordedGateway, recordedPort, activeGateway }) => {
      const entry = makeSandboxEntry(recordedGateway, recordedPort);
      const registrySnapshot = { sandboxes: { alpha: entry } };
      vi.mocked(registry.getSandbox).mockReturnValue(entry as never);
      vi.mocked(registryPersistence.load).mockReturnValue(registrySnapshot as never);
      captureOpenshellSpy.mockReturnValueOnce({ status: 0, output: "" }).mockReturnValueOnce({
        status: 1,
        output: `Error: code: 'Some requested entity was not found', message: "sandbox not found"`,
      });
      getNamedGatewayLifecycleStateSpy.mockResolvedValue({
        state: "connected_other",
        activeGateway,
        status: `Gateway: ${activeGateway}\nStatus: Connected`,
      } as never);
      const behaviorLog = vi.fn();

      await expect(resolveRebuildLiveState("alpha", entry, behaviorLog, bail)).rejects.toThrow(
        "Cannot rebuild an absent sandbox without its authoritative OpenShell policy",
      );
      expect(getNamedGatewayLifecycleStateSpy).not.toHaveBeenCalled();
      expect(gatewaySelection.selectSandboxOwningGateway).toHaveBeenCalledWith("alpha");
      expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
        1,
        ["sandbox", "list", "-g", recordedGateway],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
        2,
        ["sandbox", "get", "-g", recordedGateway, "alpha"],
        expect.anything(),
      );
      expect(registryPersistence.load).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "absent from the live OpenShell gateway",
      );
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("nemoclaw alpha destroy --yes");
      expect(behaviorLog.mock.calls.flat().join("\n")).not.toContain("Stale-sandbox recovery");
    },
  );

  it.each([
    { gatewayName: "nemoclaw", gatewayPort: 8080 },
    { gatewayName: "nemoclaw-12345", gatewayPort: 12345 },
  ])(
    "recovers $gatewayName and refuses rebuild after confirming the sandbox is absent (#4497)",
    async ({ gatewayName, gatewayPort }) => {
      const entry = makeSandboxEntry(gatewayName, gatewayPort);
      const registrySnapshot = { sandboxes: { alpha: entry } };
      vi.mocked(registry.getSandbox).mockReturnValue(entry as never);
      vi.mocked(registryPersistence.load).mockReturnValue(registrySnapshot as never);
      captureOpenshellSpy
        .mockReturnValueOnce({ status: 0, output: "beta Ready" })
        .mockReturnValueOnce({
          status: 1,
          output: `Error: code: 'Some requested entity was not found', message: "sandbox not found"`,
        });
      getNamedGatewayLifecycleStateSpy.mockResolvedValue({
        state: "healthy_named",
        activeGateway: gatewayName,
        status: `Gateway: ${gatewayName}\nStatus: Connected`,
      } as never);
      const behaviorLog = vi.fn();

      await expect(resolveRebuildLiveState("alpha", entry, behaviorLog, bail)).rejects.toThrow(
        "Cannot rebuild an absent sandbox without its authoritative OpenShell policy",
      );
      expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledOnce();
      expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
        gatewayName,
        recoverableStates: recoveryStates,
      });
      expect(recoverNamedGatewayRuntimeSpy.mock.invocationCallOrder[0]).toBeLessThan(
        captureOpenshellSpy.mock.invocationCallOrder[0]!,
      );
      expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
        1,
        ["sandbox", "list", "-g", gatewayName],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(captureOpenshellSpy).toHaveBeenNthCalledWith(
        2,
        ["sandbox", "get", "-g", gatewayName, "alpha"],
        expect.anything(),
      );
      expect(getNamedGatewayLifecycleStateSpy).not.toHaveBeenCalled();
      expect(registryPersistence.load).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.flat().join("\n")).toContain(
        "absent from the live OpenShell gateway",
      );
      expect(errorSpy.mock.calls.flat().join("\n")).toContain("nemoclaw alpha destroy --yes");
      expect(behaviorLog.mock.calls.flat().join("\n")).not.toContain("Stale-sandbox recovery");
    },
  );

  it("permits absent-sandbox recovery only with a verified transaction policy handoff", async () => {
    const entry = makeSandboxEntry();
    const registrySnapshot = { sandboxes: { alpha: entry } };
    vi.mocked(registryPersistence.load).mockReturnValue(registrySnapshot as never);
    captureOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: "beta Ready" })
      .mockReturnValueOnce({
        status: 1,
        output: `Error: code: 'Some requested entity was not found', message: "sandbox not found"`,
      });
    const behaviorLog = vi.fn();

    await expect(
      resolveRebuildLiveState("alpha", entry, behaviorLog, bail, {
        authoritativeRecoveryPolicyAvailable: true,
      }),
    ).resolves.toEqual({
      staleRecovery: true,
      staleRegistrySnapshot: registrySnapshot,
    });

    expect(registryPersistence.load).toHaveBeenCalledOnce();
    expect(behaviorLog.mock.calls.flat().join("\n")).toContain(
      "transaction-bound policy handoff is intact",
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("recovers the named gateway before a generic sandbox-list query fails (#10421)", async () => {
    const entry = makeSandboxEntry();
    captureOpenshellSpy.mockReturnValueOnce({
      status: 1,
      output: "unknown option: sandbox list",
    });

    await expect(resolveRebuildLiveState("alpha", entry, vi.fn(), bail)).rejects.toThrow(
      "Failed to query running sandboxes from OpenShell.",
    );

    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledOnce();
    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      recoverableStates: recoveryStates,
    });
    expect(captureOpenshellSpy).toHaveBeenCalledOnce();
    expect(captureOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(getNamedGatewayLifecycleStateSpy).not.toHaveBeenCalled();
    expect(registryPersistence.load).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("Failed to query running sandboxes");
  });
});

describe("rebuild owning registry routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates the complete rebuild transaction to a sibling registry root", async () => {
    const entry = {
      ...makeSandboxEntry("nemoclaw-9000", 9000),
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    };
    vi.spyOn(rebuildOwningRegistryDependencies, "findSandbox").mockReturnValue({
      entry,
      gatewayPort: 9000,
      registryGatewayPort: 9000,
      registryFile: "/home/test/.nemoclaw/gateways/9000/sandboxes.json",
    });
    const runWorker = vi
      .spyOn(rebuildOwningRegistryDependencies, "runWorker")
      .mockResolvedValue(undefined);
    const recoveryManifest = { sandboxName: "alpha", backupPath: "/backup/alpha" } as never;
    const input = {
      sandboxName: "alpha",
      options: { yes: true, verbose: true },
      executionOptions: { throwOnError: true, recoveryManifest },
    };

    const readBaseRegistry = vi.spyOn(registry, "load");

    await expect(
      rebuildSandbox(input.sandboxName, input.options, input.executionOptions),
    ).resolves.toBeUndefined();

    expect(runWorker).toHaveBeenCalledWith({ operation: "rebuild", ...input }, 9000, {
      credentialEnvNames: ["NVIDIA_INFERENCE_API_KEY"],
    });
    expect(readBaseRegistry).not.toHaveBeenCalled();
  });

  it("keeps the rebuild in-process when the selected root owns the sandbox", async () => {
    const entry = makeSandboxEntry("nemoclaw", 8080);
    vi.spyOn(rebuildOwningRegistryDependencies, "findSandbox").mockReturnValue({
      entry,
      gatewayPort: 8080,
      registryGatewayPort: 8080,
      registryFile: "/home/test/.nemoclaw/sandboxes.json",
    });
    const runWorker = vi.spyOn(rebuildOwningRegistryDependencies, "runWorker");

    await expect(
      delegateRebuildToOwningRegistry(
        { sandboxName: "alpha", options: { yes: true }, executionOptions: {} },
        "/home/test",
        "/home/test/.nemoclaw/sandboxes.json",
      ),
    ).resolves.toBe(false);

    expect(runWorker).not.toHaveBeenCalled();
  });

  it("keeps a legacy base-root row local even when it records a non-default runtime port", async () => {
    const entry = makeSandboxEntry("nemoclaw-9000", 9000);
    vi.spyOn(rebuildOwningRegistryDependencies, "findSandbox").mockReturnValue({
      entry,
      gatewayPort: 9000,
      registryGatewayPort: 8080,
      registryFile: "/home/test/.nemoclaw/sandboxes.json",
    });
    const runWorker = vi.spyOn(rebuildOwningRegistryDependencies, "runWorker");

    await expect(
      delegateRebuildToOwningRegistry(
        { sandboxName: "alpha", options: { yes: true }, executionOptions: {} },
        "/home/test",
        "/home/test/.nemoclaw/sandboxes.json",
      ),
    ).resolves.toBe(false);

    expect(runWorker).not.toHaveBeenCalled();
  });

  it("fails fast instead of deadlocking when a parent lifecycle command owns the host fence", async () => {
    const entry = makeSandboxEntry("nemoclaw-9000", 9000);
    vi.spyOn(rebuildOwningRegistryDependencies, "findSandbox").mockReturnValue({
      entry,
      gatewayPort: 9000,
      registryGatewayPort: 9000,
      registryFile: "/home/test/.nemoclaw/gateways/9000/sandboxes.json",
    });
    vi.spyOn(rebuildOwningRegistryDependencies, "isHostFenceHeld").mockReturnValue(true);
    const runWorker = vi.spyOn(rebuildOwningRegistryDependencies, "runWorker");

    await expect(
      delegateRebuildToOwningRegistry(
        { sandboxName: "alpha", options: { yes: true }, executionOptions: {} },
        "/home/test",
        "/home/test/.nemoclaw/sandboxes.json",
      ),
    ).rejects.toThrow("Run 'nemoclaw alpha rebuild' directly");

    expect(runWorker).not.toHaveBeenCalled();
  });

  it("confirms a sibling-root rebuild in the parent before starting its detached worker", async () => {
    const entry = makeSandboxEntry("nemoclaw-9000", 9000);
    vi.spyOn(rebuildOwningRegistryDependencies, "findSandbox").mockReturnValue({
      entry,
      gatewayPort: 9000,
      registryGatewayPort: 9000,
      registryFile: "/home/test/.nemoclaw/gateways/9000/sandboxes.json",
    });
    vi.spyOn(rebuildOwningRegistryDependencies, "isHostFenceHeld").mockReturnValue(false);
    const confirmInteractiveRebuild = vi
      .spyOn(rebuildOwningRegistryDependencies, "confirmInteractiveRebuild")
      .mockResolvedValue(true);
    const runWorker = vi
      .spyOn(rebuildOwningRegistryDependencies, "runWorker")
      .mockResolvedValue(undefined);

    await expect(
      delegateRebuildToOwningRegistry(
        { sandboxName: "alpha", options: {}, executionOptions: {} },
        "/home/test",
        "/home/test/.nemoclaw/sandboxes.json",
      ),
    ).resolves.toBe(true);

    expect(confirmInteractiveRebuild).toHaveBeenCalledWith("alpha", undefined);
    expect(runWorker).toHaveBeenCalledWith(
      {
        operation: "rebuild",
        sandboxName: "alpha",
        options: { yes: true },
        executionOptions: {},
      },
      9000,
      { credentialEnvNames: [] },
    );
  });

  it("keeps a cancelled sibling-root rebuild non-mutating", async () => {
    const entry = makeSandboxEntry("nemoclaw-9000", 9000);
    vi.spyOn(rebuildOwningRegistryDependencies, "findSandbox").mockReturnValue({
      entry,
      gatewayPort: 9000,
      registryGatewayPort: 9000,
      registryFile: "/home/test/.nemoclaw/gateways/9000/sandboxes.json",
    });
    vi.spyOn(rebuildOwningRegistryDependencies, "isHostFenceHeld").mockReturnValue(false);
    vi.spyOn(rebuildOwningRegistryDependencies, "confirmInteractiveRebuild").mockResolvedValue(
      false,
    );
    const runWorker = vi.spyOn(rebuildOwningRegistryDependencies, "runWorker");

    await expect(
      delegateRebuildToOwningRegistry(
        { sandboxName: "alpha", options: {}, executionOptions: {} },
        "/home/test",
        "/home/test/.nemoclaw/sandboxes.json",
      ),
    ).resolves.toBe(true);

    expect(runWorker).not.toHaveBeenCalled();
  });

  it("rejects duplicate exact recovery records across gateway roots", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recovery-roots-"));
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const timestamp = "2026-09-17T00-00-00-000Z";
    try {
      const firstBackup = path.join(
        home,
        ".nemoclaw",
        "gateways",
        "9000",
        "rebuild-backups",
        "alpha",
        timestamp,
      );
      const secondBackup = path.join(
        home,
        ".nemoclaw",
        "gateways",
        "9001",
        "rebuild-backups",
        "alpha",
        timestamp,
      );
      fs.mkdirSync(firstBackup, { recursive: true });
      fs.mkdirSync(secondBackup, { recursive: true });
      fs.writeFileSync(
        path.join(firstBackup, ".nemoclaw-rebuild-recovery.json"),
        `${JSON.stringify({
          schemaVersion: 3,
          transactionId,
          sandboxName: "alpha",
          backupTimestamp: timestamp,
          gatewayName: "nemoclaw-9000",
          gatewayPort: 9000,
          phase: "restore",
        })}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(secondBackup, ".nemoclaw-rebuild-recovery.json"),
        `${JSON.stringify({
          schemaVersion: 3,
          transactionId,
          sandboxName: "alpha",
          backupTimestamp: timestamp,
          gatewayName: "nemoclaw-9001",
          gatewayPort: 9001,
          phase: "restore",
        })}\n`,
        { mode: 0o600 },
      );

      expect(() =>
        findRebuildRecoveryStorageRoot(
          { sandboxName: "alpha", transactionId, confirmDataRecovered: true },
          home,
        ),
      ).toThrow("More than one exact rebuild recovery record");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      description: "gateway port differs from its state root",
      gatewayName: "nemoclaw-9001",
      gatewayPort: 9001,
      expected: "gateway port 9001 does not match state root port 9000",
    },
    {
      description: "gateway name differs from its state root",
      gatewayName: "nemoclaw-9001",
      gatewayPort: 9000,
      expected: "gateway name 'nemoclaw-9001' does not match state root gateway 'nemoclaw-9000'",
    },
  ])(
    "rejects a recovery marker whose $description before worker delegation",
    async ({ gatewayName, gatewayPort, expected }) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recovery-root-port-"));
      const transactionId = "11111111-1111-4111-8111-111111111111";
      const timestamp = "2026-09-17T00-00-00-000Z";
      const backupPath = path.join(
        home,
        ".nemoclaw",
        "gateways",
        "9000",
        "rebuild-backups",
        "alpha",
        timestamp,
      );
      const recoveryFile = path.join(backupPath, ".nemoclaw-rebuild-recovery.json");
      vi.spyOn(rebuildOwningRegistryDependencies, "isHostFenceHeld").mockReturnValue(false);
      const runWorker = vi.spyOn(rebuildOwningRegistryDependencies, "runWorker");
      try {
        fs.mkdirSync(backupPath, { recursive: true });
        fs.writeFileSync(
          recoveryFile,
          `${JSON.stringify({
            schemaVersion: 3,
            transactionId,
            sandboxName: "alpha",
            backupTimestamp: timestamp,
            gatewayName,
            gatewayPort,
            phase: "restore",
          })}\n`,
          { mode: 0o600 },
        );

        await expect(
          delegateRecoveryRetirementToOwningRegistry(
            { sandboxName: "alpha", transactionId, confirmDataRecovered: true },
            home,
            path.join(home, ".nemoclaw", "sandboxes.json"),
          ),
        ).rejects.toThrow(expected);
        expect(runWorker).not.toHaveBeenCalled();
        expect(fs.existsSync(recoveryFile)).toBe(true);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("rejects traversal-shaped recovery names before reading gateway roots", () => {
    const readDirectory = vi.spyOn(fs, "readdirSync");

    expect(() =>
      findRebuildRecoveryStorageRoot(
        {
          sandboxName: "../outside",
          transactionId: "11111111-1111-4111-8111-111111111111",
          confirmDataRecovered: true,
        },
        "/home/test",
      ),
    ).toThrow("Invalid sandbox name.");

    expect(readDirectory).not.toHaveBeenCalled();
  });
});
