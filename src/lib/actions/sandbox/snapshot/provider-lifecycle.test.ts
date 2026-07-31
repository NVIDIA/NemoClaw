// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedProfileRestoreAuthority,
  RuntimeProviderRuntimeReceipt,
} from "../../../onboard/runtime-provider/contract";
import type { SandboxEntry } from "../../../state/registry/types";
import {
  captureSandboxRuntimeSnapshot,
  confirmSandboxRuntimeRestore,
  prepareSandboxRuntimeRestore,
} from "./provider-lifecycle";

function sandbox(name = "alpha"): SandboxEntry {
  return { name, agent: "openclaw", openshellDriver: "mxc" };
}

function runtime(providerId = "mxc"): RuntimeProviderRuntimeReceipt {
  return {
    schemaVersion: 1,
    providerId,
    runtime: { kind: "session", handle: `opaque-${providerId}-session` },
    acceleration: { kind: "none" },
  };
}

const managedProfile = {
  agent: "openclaw",
  profileFingerprint: "a".repeat(64),
} as const satisfies RuntimeProviderManagedProfileRestoreAuthority;

function provider(
  options: {
    providerId?: string;
    preflightProviderId?: string;
    runtimeProviderId?: string;
    restoreProviderId?: string;
  } = {},
): {
  readonly bundle: RuntimeProviderBundle;
  readonly preflight: ReturnType<typeof vi.fn>;
  readonly capture: ReturnType<typeof vi.fn>;
  readonly validateRestore: ReturnType<typeof vi.fn>;
  readonly restore: ReturnType<typeof vi.fn>;
} {
  const providerId = options.providerId ?? "mxc";
  const preflight = vi.fn((operation: "backup" | "restore", entry: SandboxEntry) => ({
    schemaVersion: 1 as const,
    providerId: options.preflightProviderId ?? providerId,
    operation,
    sandboxName: entry.name,
    providerHandle: `opaque-${providerId}-preflight`,
    lifecycleState: "running" as const,
    lifecycleGeneration: "generation-1",
  }));
  const capture = vi.fn(() => runtime(options.runtimeProviderId ?? providerId));
  const validateRestore = vi.fn();
  const restore = vi.fn(
    (
      entry: SandboxEntry,
      _preflight: unknown,
      _runtime: unknown,
      authority: RuntimeProviderManagedProfileRestoreAuthority,
    ) => ({
      schemaVersion: 1 as const,
      providerId: options.restoreProviderId ?? providerId,
      sandboxName: entry.name,
      providerHandle: `opaque-${providerId}-restore`,
      lifecycleState: "running" as const,
      lifecycleGeneration: "generation-1",
      runtime: runtime(options.runtimeProviderId ?? providerId),
      managedProfile: authority,
    }),
  );
  return {
    bundle: {
      identity: { contractVersion: 1, id: providerId, displayName: providerId },
      snapshot: {
        providerId,
        supported: true,
        contractVersion: 1,
        capabilities: { backup: true, restore: true, managedProfileRestore: true },
        preflight,
        capture,
        validateRestore,
        restore,
      },
    } as unknown as RuntimeProviderBundle,
    preflight,
    capture,
    validateRestore,
    restore,
  };
}

describe("snapshot provider lifecycle", () => {
  it("captures provider-neutral runtime and lifecycle state behind opaque handles", () => {
    const { bundle, preflight, capture } = provider();

    expect(captureSandboxRuntimeSnapshot(bundle, sandbox())).toEqual({
      schemaVersion: 1,
      providerId: "mxc",
      providerHandle: "opaque-mxc-preflight",
      lifecycleState: "running",
      lifecycleGeneration: "generation-1",
      runtime: runtime(),
    });
    expect(preflight).toHaveBeenCalledWith("backup", expect.objectContaining({ name: "alpha" }));
    expect(capture).toHaveBeenCalledOnce();
  });

  it("preflights before restore and revalidates through the same injected facet", () => {
    const { bundle, restore, validateRestore } = provider();
    const target = sandbox("target");
    const source = {
      schemaVersion: 1,
      providerId: "mxc",
      providerHandle: "opaque-source",
      lifecycleState: "running",
      lifecycleGeneration: "source-generation",
      runtime: runtime(),
    };

    const prepared = prepareSandboxRuntimeRestore(bundle, target, source, managedProfile);
    const validated = confirmSandboxRuntimeRestore(bundle, target, prepared);

    expect(prepared.phase).toBe("preflighted");
    expect(validateRestore).toHaveBeenCalledWith(
      target,
      prepared.preflight,
      expect.objectContaining({ providerId: "mxc" }),
      managedProfile,
    );
    expect(validated.phase).toBe("validated");
    expect(restore).toHaveBeenCalledWith(
      target,
      prepared.preflight,
      expect.objectContaining({ providerId: "mxc" }),
      managedProfile,
    );
    expect(validated.restoreReceipt).toMatchObject({
      providerId: "mxc",
      managedProfile,
    });
  });

  it("leaves opaque provider and runtime handles under provider ownership", () => {
    const { bundle, restore } = provider();
    const target = sandbox("target");
    const prepared = prepareSandboxRuntimeRestore(
      bundle,
      target,
      {
        schemaVersion: 1,
        providerId: "mxc",
        providerHandle: "opaque-source-provider",
        lifecycleState: "running",
        lifecycleGeneration: "source-generation",
        runtime: {
          ...runtime(),
          runtime: { kind: "session", handle: "opaque-source-runtime" },
        },
      },
      managedProfile,
    );
    restore.mockReturnValueOnce({
      schemaVersion: 1,
      providerId: "mxc",
      sandboxName: "target",
      providerHandle: "opaque-provider-owned-restore",
      lifecycleState: "running",
      lifecycleGeneration: "generation-1",
      runtime: {
        ...runtime(),
        runtime: { kind: "replacement-session", handle: "opaque-provider-owned-runtime" },
      },
      managedProfile,
    });

    expect(confirmSandboxRuntimeRestore(bundle, target, prepared).restoreReceipt).toMatchObject({
      providerHandle: "opaque-provider-owned-restore",
      runtime: {
        runtime: { kind: "replacement-session", handle: "opaque-provider-owned-runtime" },
      },
    });
  });

  it("rejects provider identity drift before returning snapshot authority", () => {
    expect(() =>
      captureSandboxRuntimeSnapshot(provider({ preflightProviderId: "other" }).bundle, sandbox()),
    ).toThrow(/invalid backup preflight authority/u);
    expect(() =>
      captureSandboxRuntimeSnapshot(provider({ runtimeProviderId: "other" }).bundle, sandbox()),
    ).toThrow(/unrepresentable runtime state/u);
  });

  it("fails preflight when the target cannot represent snapshot lifecycle state", () => {
    const { bundle, restore } = provider();
    expect(() =>
      prepareSandboxRuntimeRestore(
        bundle,
        sandbox("target"),
        {
          schemaVersion: 1,
          providerId: "mxc",
          providerHandle: "opaque-source",
          lifecycleState: "paused",
          lifecycleGeneration: "source-generation",
          runtime: runtime(),
        },
        managedProfile,
      ),
    ).toThrow(/cannot represent the snapshot lifecycle state/u);
    expect(restore).not.toHaveBeenCalled();
  });

  it("propagates provider restore refusal from the read-only preflight edge", () => {
    const { bundle, validateRestore, restore } = provider();
    validateRestore.mockImplementationOnce(() => {
      throw new Error("source provider handle is invalid");
    });

    expect(() =>
      prepareSandboxRuntimeRestore(
        bundle,
        sandbox("target"),
        {
          schemaVersion: 1,
          providerId: "mxc",
          providerHandle: "tampered-source",
          lifecycleState: "running",
          lifecycleGeneration: "source-generation",
          runtime: runtime(),
        },
        managedProfile,
      ),
    ).toThrow(/source provider handle is invalid/u);
    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects stale target authority without calling provider restore", () => {
    const { bundle, restore } = provider();
    const prepared = prepareSandboxRuntimeRestore(
      bundle,
      sandbox("target"),
      {
        schemaVersion: 1,
        providerId: "mxc",
        providerHandle: "opaque",
        lifecycleState: "running",
        lifecycleGeneration: "generation-1",
        runtime: runtime(),
      },
      managedProfile,
    );

    expect(() => confirmSandboxRuntimeRestore(bundle, sandbox("replacement"), prepared)).toThrow(
      /restore preflight authority is stale/u,
    );
    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects cross-provider runtime authority before target preflight", () => {
    const { bundle, preflight } = provider();
    expect(() =>
      prepareSandboxRuntimeRestore(
        bundle,
        sandbox("target"),
        {
          schemaVersion: 1,
          providerId: "other",
          providerHandle: "opaque-other",
          lifecycleState: "running",
          lifecycleGeneration: "generation-1",
          runtime: runtime("other"),
        },
        managedProfile,
      ),
    ).toThrow(/does not match target provider/u);
    expect(preflight).not.toHaveBeenCalled();
  });

  it("rejects an invalid managed profile authority and provider restore proof", () => {
    const source = {
      schemaVersion: 1,
      providerId: "mxc",
      providerHandle: "opaque",
      lifecycleState: "running",
      lifecycleGeneration: "generation-1",
      runtime: runtime(),
    };
    expect(() =>
      prepareSandboxRuntimeRestore(provider().bundle, sandbox("target"), source, {
        ...managedProfile,
        profileFingerprint: "not-a-digest",
      }),
    ).toThrow(/managed profile restore authority is invalid/u);

    const { bundle } = provider({ restoreProviderId: "other" });
    const prepared = prepareSandboxRuntimeRestore(
      bundle,
      sandbox("target"),
      source,
      managedProfile,
    );
    expect(() => confirmSandboxRuntimeRestore(bundle, sandbox("target"), prepared)).toThrow(
      /invalid managed restore proof/u,
    );
  });

  it.each([
    { field: "lifecycle state", lifecycleState: "stopped", lifecycleGeneration: "generation-1" },
    { field: "lifecycle generation", lifecycleState: "running", lifecycleGeneration: "changed" },
  ] as const)("rejects restore proof with changed $field", ({
    lifecycleState,
    lifecycleGeneration,
  }) => {
    const { bundle, restore } = provider();
    const target = sandbox("target");
    const prepared = prepareSandboxRuntimeRestore(
      bundle,
      target,
      {
        schemaVersion: 1,
        providerId: "mxc",
        providerHandle: "opaque-source",
        lifecycleState: "running",
        lifecycleGeneration: "source-generation",
        runtime: runtime(),
      },
      managedProfile,
    );
    restore.mockReturnValueOnce({
      schemaVersion: 1,
      providerId: "mxc",
      sandboxName: "target",
      providerHandle: "provider-owned-restore-handle",
      lifecycleState,
      lifecycleGeneration,
      runtime: runtime(),
      managedProfile,
    });

    expect(() => confirmSandboxRuntimeRestore(bundle, target, prepared)).toThrow(
      /invalid managed restore proof/u,
    );
  });

  it("rejects restore proof that changes acceleration authority", () => {
    const { bundle } = provider();
    const target = sandbox("target");
    const prepared = prepareSandboxRuntimeRestore(
      bundle,
      target,
      {
        schemaVersion: 1,
        providerId: "mxc",
        providerHandle: "opaque-source",
        lifecycleState: "running",
        lifecycleGeneration: "source-generation",
        runtime: {
          ...runtime(),
          acceleration: { kind: "gpu", vendor: "nvidia", devices: ["GPU-0"] },
        },
      },
      managedProfile,
    );

    expect(() => confirmSandboxRuntimeRestore(bundle, target, prepared)).toThrow(
      /invalid managed restore proof/u,
    );
  });

  it("isolates central authority from a hostile provider that mutates backup inputs", () => {
    const { bundle, capture } = provider();
    capture.mockImplementationOnce((_entry, preflight) => {
      (preflight as { providerHandle: string }).providerHandle = "mutated";
      return runtime();
    });

    expect(() => captureSandboxRuntimeSnapshot(bundle, sandbox())).toThrow(TypeError);
  });

  it("isolates central authority from a hostile MXC-style restore facet", () => {
    const { bundle, validateRestore } = provider();
    validateRestore.mockImplementationOnce((_entry, _preflight, source, authority) => {
      (source as { providerHandle: string }).providerHandle = "mutated";
      (authority as { agent: string }).agent = "other";
    });

    expect(() =>
      prepareSandboxRuntimeRestore(
        bundle,
        sandbox("target"),
        {
          schemaVersion: 1,
          providerId: "mxc",
          providerHandle: "opaque-source",
          lifecycleState: "running",
          lifecycleGeneration: "source-generation",
          runtime: runtime(),
        },
        managedProfile,
      ),
    ).toThrow(TypeError);
  });
});
