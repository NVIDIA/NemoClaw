// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runStandaloneJetsonOpenRmPolicyProof } from "./jetson-openrm-standalone";

function verifierFactory() {
  return vi.fn(() => vi.fn());
}

describe("standalone Jetson OpenRM policy proof", () => {
  it("runs the production recreation boundary and restores it after cuInit 801 (#7610)", async () => {
    const rollback = vi.fn(async () => undefined);
    const createPatch = vi.fn(() => ({
      ensureApplied: vi.fn(async () => undefined),
      waitForSupervisorReconnectIfNeeded: vi.fn(),
      verifyGpuOrExit: vi.fn(async () => {
        throw new Error("Sandbox GPU proof returned failed status (cuInit(0)=801)");
      }),
      rollbackManagedStartupAfterCreateFailure: rollback,
    }));

    await runStandaloneJetsonOpenRmPolicyProof("alpha", {
      createPatch,
      createVerifier: verifierFactory(),
      runCaptureOpenshell: vi.fn(),
      runOpenshell: vi.fn(),
    });

    expect(createPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "compatibility",
        sandboxName: "alpha",
        backend: "jetson",
        preserveJetsonDeviceGroupMembership: true,
      }),
    );
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("restores the original container after an unexpected proof failure (#7610)", async () => {
    const rollback = vi.fn(async () => undefined);
    const createPatch = vi.fn(() => ({
      ensureApplied: vi.fn(async () => undefined),
      waitForSupervisorReconnectIfNeeded: vi.fn(),
      verifyGpuOrExit: vi.fn(async () => {
        throw new Error("cuInit(0)=100");
      }),
      rollbackManagedStartupAfterCreateFailure: rollback,
    }));

    await expect(
      runStandaloneJetsonOpenRmPolicyProof("alpha", {
        createPatch,
        createVerifier: verifierFactory(),
        runCaptureOpenshell: vi.fn(),
        runOpenshell: vi.fn(),
      }),
    ).rejects.toThrow("cuInit(0)=100");
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("does not accept cuInit 801 when the production rollback failed (#7610)", async () => {
    const rollbackError = new Error("pre-patch container was not restored");
    const proofError = Object.assign(new Error("cuInit(0)=801"), {
      managedBootstrapRollbackError: rollbackError,
    });
    const createPatch = vi.fn(() => ({
      ensureApplied: vi.fn(async () => undefined),
      waitForSupervisorReconnectIfNeeded: vi.fn(),
      verifyGpuOrExit: vi.fn(async () => {
        throw proofError;
      }),
      rollbackManagedStartupAfterCreateFailure: vi.fn(async () => undefined),
    }));

    await expect(
      runStandaloneJetsonOpenRmPolicyProof("alpha", {
        createPatch,
        createVerifier: verifierFactory(),
        runCaptureOpenshell: vi.fn(),
        runOpenshell: vi.fn(),
      }),
    ).rejects.toThrow("cuInit(0)=801");
  });

  it("rejects an invalid sandbox name before creating a patch (#7610)", async () => {
    const createPatch = vi.fn();
    await expect(
      runStandaloneJetsonOpenRmPolicyProof("alpha;docker ps", { createPatch }),
    ).rejects.toThrow("Invalid sandbox name");
    expect(createPatch).not.toHaveBeenCalled();
  });
});
