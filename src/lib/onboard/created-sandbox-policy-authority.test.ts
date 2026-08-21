// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../state/registry";
import {
  completeOrdinaryOnboardSandboxCreation,
  createCreatedSandboxCompletionActions,
  finalizeCreatedSandbox,
} from "./created-sandbox-finalization";
import { runSandboxDeleteWithPolicyAuthorityCheck } from "./sandbox-create/orchestration";

const refuseAuthorityChange = (): never => {
  throw new Error("policy authority changed");
};

function finalizationOptions(restoreBackupPath: string | null) {
  return {
    sandboxName: "alpha",
    restoreBackupPath,
    preUpgradeBackup: false,
    targetAgentType: "openclaw",
    validateManagedDcode: false,
    provider: "nvidia-prod",
    model: "model",
    preferredInferenceApi: null,
  };
}

function finalizationDeps() {
  return {
    revalidatePolicyAuthority: vi.fn<(operation: string) => void>(),
    discoverFreshOpenClawImagePluginInstalls: vi.fn(),
    restoreRecreatedSandboxState: vi.fn(),
    getDcodeSelectionDrift: vi.fn(),
    register: vi.fn(),
    note: vi.fn(),
    error: vi.fn(),
    exitProcess: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

function ordinaryDeps() {
  return {
    setDefault: vi.fn(),
    runFile: vi.fn(),
    scriptsDir: "/tmp/scripts",
    gatewayName: "nemoclaw",
    providerExistsInGateway: vi.fn(() => true),
    armCancelRollback: vi.fn(),
    dockerInfoFormat: vi.fn(() => "true"),
    runCapture: vi.fn(() => ""),
    revalidatePolicyAuthority: vi.fn<(operation: string) => void>(),
  };
}

describe("created sandbox policy authority boundaries", () => {
  it("rechecks after provider cleanup before deleting the sandbox (#9833)", () => {
    const events: string[] = [];

    expect(() =>
      runSandboxDeleteWithPolicyAuthorityCheck({
        cleanupProviders: () => events.push("cleanup"),
        revalidate: () => {
          events.push("check");
          throw new Error("policy authority changed");
        },
        deleteSandbox: () => events.push("delete"),
      }),
    ).toThrow("policy authority changed");
    expect(events).toEqual(["cleanup", "check"]);
  });

  it("refuses file restore when the Ready sandbox authority changed (#9833)", () => {
    const deps = finalizationDeps();
    deps.revalidatePolicyAuthority.mockImplementation(() => {
      throw new Error("policy authority changed");
    });

    expect(() => finalizeCreatedSandbox(finalizationOptions("/tmp/backup"), deps)).toThrow(
      "policy authority changed",
    );
    expect(deps.restoreRecreatedSandboxState).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("rechecks immediately before publishing the Ready sandbox (#9833)", () => {
    const deps = finalizationDeps();
    deps.revalidatePolicyAuthority.mockImplementation(() => {
      throw new Error("policy authority changed");
    });

    expect(() => finalizeCreatedSandbox(finalizationOptions(null), deps)).toThrow(
      "policy authority changed",
    );
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("refuses default, DNS, and rollback mutations at completion entry (#9833)", () => {
    const deps = ordinaryDeps();
    deps.revalidatePolicyAuthority.mockImplementation(() => {
      throw new Error("policy authority changed");
    });

    expect(() =>
      completeOrdinaryOnboardSandboxCreation(
        {
          sandboxName: "alpha",
          sandboxWasLiveDefault: true,
          runtimeFields: { openshellDriver: "kubernetes" } as SandboxEntry,
          messagingProviders: ["alpha-slack"],
          liveExists: false,
        },
        deps,
      ),
    ).toThrow("policy authority changed");
    expect(deps.setDefault).not.toHaveBeenCalled();
    expect(deps.runFile).not.toHaveBeenCalled();
    expect(deps.armCancelRollback).not.toHaveBeenCalled();
  });

  it("rechecks after the DNS proxy command before applying VM DNS settings (#9833)", () => {
    const deps = { ...ordinaryDeps(), applyVmDnsMonkeypatch: vi.fn() };
    deps.revalidatePolicyAuthority.mockImplementation((operation) =>
      operation.startsWith("applying DNS settings") ? refuseAuthorityChange() : undefined,
    );

    expect(() =>
      completeOrdinaryOnboardSandboxCreation(
        {
          sandboxName: "alpha",
          sandboxWasLiveDefault: false,
          runtimeFields: { openshellDriver: "kubernetes" } as SandboxEntry,
          messagingProviders: [],
          liveExists: true,
        },
        deps,
      ),
    ).toThrow("policy authority changed");

    expect(deps.runFile).toHaveBeenCalledOnce();
    expect(deps.applyVmDnsMonkeypatch).not.toHaveBeenCalled();
    expect(deps.armCancelRollback).not.toHaveBeenCalled();
  });

  it("rechecks after restoring the default before DNS mutations (#9833)", () => {
    const deps = { ...ordinaryDeps(), applyVmDnsMonkeypatch: vi.fn() };
    deps.revalidatePolicyAuthority
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(refuseAuthorityChange);

    expect(() =>
      completeOrdinaryOnboardSandboxCreation(
        {
          sandboxName: "alpha",
          sandboxWasLiveDefault: true,
          runtimeFields: { openshellDriver: "kubernetes" } as SandboxEntry,
          messagingProviders: [],
          liveExists: true,
        },
        deps,
      ),
    ).toThrow("policy authority changed");

    expect(deps.setDefault).toHaveBeenCalledWith("alpha");
    expect(deps.runFile).not.toHaveBeenCalled();
    expect(deps.applyVmDnsMonkeypatch).not.toHaveBeenCalled();
  });

  it("rechecks before reporting creation success (#9833)", () => {
    const deps = ordinaryDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    deps.revalidatePolicyAuthority.mockImplementation((operation) =>
      operation.startsWith("reporting sandbox") ? refuseAuthorityChange() : undefined,
    );

    expect(() =>
      completeOrdinaryOnboardSandboxCreation(
        {
          sandboxName: "alpha",
          sandboxWasLiveDefault: false,
          runtimeFields: { openshellDriver: "docker" } as SandboxEntry,
          messagingProviders: [],
          liveExists: false,
        },
        deps,
      ),
    ).toThrow("policy authority changed");

    expect(log).not.toHaveBeenCalledWith("  ✓ Sandbox 'alpha' created");
    expect(deps.armCancelRollback).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("rechecks after dashboard port release before creating a forward (#9833)", async () => {
    const releasePort = vi.fn(async () => undefined);
    const ensureForward = vi.fn(
      (
        _sandboxName: string,
        _chatUiUrl: string,
        options: { revalidatePolicyAuthority?: (operation: string) => void },
      ) => {
        options.revalidatePolicyAuthority?.("start the dashboard forward");
        return 8643;
      },
    );
    const revalidatePolicyAuthority = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(refuseAuthorityChange);
    const completion = createCreatedSandboxCompletionActions(
      {
        finalization: { sandboxName: "alpha" },
        dashboard: { releasePort, ensureForward },
      } as unknown as Parameters<typeof createCreatedSandboxCompletionActions>[0],
      {
        revalidatePolicyAuthority,
      } as unknown as Parameters<typeof createCreatedSandboxCompletionActions>[1],
    );

    await expect(
      completion.complete(
        null,
        null,
        "disabled",
        true,
        () => ({ lifecycleGeneration: "generation-1" }),
        {} as never,
      ),
    ).rejects.toThrow("policy authority changed");

    expect(releasePort).toHaveBeenCalledOnce();
    expect(ensureForward).not.toHaveBeenCalled();
  });

  it("rechecks after creating the dashboard forward before Hermes publication (#9833)", async () => {
    const releasePort = vi.fn(async () => undefined);
    const ensureForward = vi.fn(() => 8643);
    const ensureHermesForward = vi.fn();
    const registerCreatedSandbox = vi.fn();
    const revalidatePolicyAuthority = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(refuseAuthorityChange);
    const completion = createCreatedSandboxCompletionActions(
      {
        finalization: { sandboxName: "alpha" },
        dashboard: {
          releasePort,
          ensureForward,
          ensureHermesForward,
          getForwardPort: () => "8643",
        },
      } as unknown as Parameters<typeof createCreatedSandboxCompletionActions>[0],
      {
        revalidatePolicyAuthority,
        registerCreatedSandbox,
      } as unknown as Parameters<typeof createCreatedSandboxCompletionActions>[1],
    );

    await expect(
      completion.complete(
        null,
        null,
        "disabled",
        true,
        () => ({ lifecycleGeneration: "generation-1" }),
        {} as never,
      ),
    ).rejects.toThrow("policy authority changed");

    expect(ensureForward).toHaveBeenCalledOnce();
    expect(ensureHermesForward).not.toHaveBeenCalled();
    expect(registerCreatedSandbox).not.toHaveBeenCalled();
  });

  it("rechecks after Hermes forwarding before sandbox registration (#9833)", async () => {
    const ensureHermesForward = vi.fn();
    const registerCreatedSandbox = vi.fn();
    const revalidatePolicyAuthority = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(refuseAuthorityChange);
    const completion = createCreatedSandboxCompletionActions(
      {
        finalization: { sandboxName: "alpha" },
        dashboard: {
          releasePort: vi.fn(async () => undefined),
          ensureForward: vi.fn(() => 8643),
          ensureHermesForward,
          getForwardPort: () => "8643",
          resolveHermesState: () => ({ enabled: false, config: null }),
        },
      } as unknown as Parameters<typeof createCreatedSandboxCompletionActions>[0],
      {
        revalidatePolicyAuthority,
        registerCreatedSandbox,
      } as unknown as Parameters<typeof createCreatedSandboxCompletionActions>[1],
    );

    await expect(
      completion.complete(
        null,
        null,
        "disabled",
        true,
        () => ({ lifecycleGeneration: "generation-1" }),
        {} as never,
      ),
    ).rejects.toThrow("policy authority changed");

    expect(ensureHermesForward).toHaveBeenCalledOnce();
    expect(ensureHermesForward).toHaveBeenCalledWith(
      { enabled: false, config: null },
      "alpha",
      true,
      revalidatePolicyAuthority,
    );
    expect(registerCreatedSandbox).not.toHaveBeenCalled();
  });

  it("rechecks after state restore before reporting its result (#9833)", () => {
    const deps = finalizationDeps();
    deps.restoreRecreatedSandboxState.mockReturnValue({
      success: true,
      restoredDirs: ["workspace"],
      restoredFiles: ["config.json"],
    });
    deps.revalidatePolicyAuthority
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(refuseAuthorityChange);

    expect(() => finalizeCreatedSandbox(finalizationOptions("/tmp/backup"), deps)).toThrow(
      "policy authority changed",
    );

    expect(deps.restoreRecreatedSandboxState).toHaveBeenCalledOnce();
    expect(deps.note).not.toHaveBeenCalledWith(expect.stringContaining("State restored"));
    expect(deps.register).not.toHaveBeenCalled();
  });
});
