// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import type { SandboxEntry } from "../../state/registry/types";
import { startStoppedSandboxContainerForProbeRecovery } from "./gateway-state";

const sandboxId = "sandbox-alpha";
const sandboxIdentityFingerprint = fingerprintOpenShellSandboxId(sandboxId)!;

function registeredSandbox(openshellDriver: "docker" | "podman" = "docker"): SandboxEntry {
  return {
    name: "alpha",
    gatewayName: "nemoclaw-8091",
    lifecycleLiveIdentityFingerprint: sandboxIdentityFingerprint,
    openshellDriver,
  };
}

function harness(
  input: {
    readonly openshellDriver?: "docker" | "podman";
    readonly phase?: string;
    readonly registered?: SandboxEntry | null;
    readonly startResult?:
      | Readonly<{ kind: "accepted" }>
      | Readonly<{
          kind: "failed";
          error: Readonly<{
            kind: "transport";
            reason: "identity_mismatch";
            message: string;
          }>;
        }>;
  } = {},
) {
  const startSandbox = vi.fn(async () => input.startResult ?? ({ kind: "accepted" } as const));
  const stopSandbox = vi.fn(async () => ({ kind: "accepted" }) as const);
  const capture = vi.fn(() => ({
    status: 0,
    output: `Name: alpha\nPhase: ${input.phase ?? "Stopped"}\n`,
  }));
  const getSandbox = vi.fn(() =>
    "registered" in input
      ? (input.registered ?? null)
      : registeredSandbox(input.openshellDriver ?? "docker"),
  );
  return {
    capture: capture as never,
    captureSpy: capture,
    getSandbox,
    openShellLifecycle: { startSandbox, stopSandbox },
    startSandbox,
    stopSandbox,
  };
}

describe("startStoppedSandboxContainerForProbeRecovery", () => {
  it.each(["docker", "podman"] as const)(
    "starts one registered stopped %s sandbox through the identity-checked OpenShell boundary",
    async (openshellDriver) => {
      const deps = harness({ openshellDriver });

      await expect(startStoppedSandboxContainerForProbeRecovery("alpha", deps)).resolves.toBe(true);

      expect(deps.captureSpy).toHaveBeenCalledWith(
        ["sandbox", "get", "-g", "nemoclaw-8091", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(deps.startSandbox).toHaveBeenCalledWith({
        sandboxName: "alpha",
        sandboxIdentityFingerprint,
        target: { kind: "named", gatewayName: "nemoclaw-8091" },
      });
      expect(deps.stopSandbox).not.toHaveBeenCalled();
    },
  );

  it("does not submit a lifecycle mutation when OpenShell is not Stopped", async () => {
    const deps = harness({ phase: "Ready" });

    await expect(startStoppedSandboxContainerForProbeRecovery("alpha", deps)).resolves.toBe(false);

    expect(deps.getSandbox).toHaveBeenCalledOnce();
    expect(deps.startSandbox).not.toHaveBeenCalled();
  });

  it("does not submit a lifecycle mutation when the owning gateway cannot be observed", async () => {
    const deps = harness();
    deps.captureSpy.mockReturnValue({ status: 1, output: "gateway unavailable" });

    await expect(startStoppedSandboxContainerForProbeRecovery("alpha", deps)).resolves.toBe(false);

    expect(deps.getSandbox).toHaveBeenCalledOnce();
    expect(deps.startSandbox).not.toHaveBeenCalled();
  });

  it("does not submit a name-only start for an unregistered sandbox", async () => {
    const deps = harness({ registered: null });

    await expect(startStoppedSandboxContainerForProbeRecovery("alpha", deps)).resolves.toBe(false);

    expect(deps.startSandbox).not.toHaveBeenCalled();
  });

  it("retains a legacy row without submitting an identity-less start", async () => {
    const deps = harness({
      registered: { ...registeredSandbox(), lifecycleLiveIdentityFingerprint: undefined },
    });

    await expect(startStoppedSandboxContainerForProbeRecovery("alpha", deps)).resolves.toBe(false);

    expect(deps.startSandbox).not.toHaveBeenCalled();
  });
});
