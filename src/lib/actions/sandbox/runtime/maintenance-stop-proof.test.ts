// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRegisteredRuntimeProvider } from "../../../onboard/runtime-provider/selection";
import * as registry from "../../../state/registry";
import { prepareMaintenanceStopProof } from "../process-recovery";

vi.mock("../../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/registry")>()),
  getSandboxAcrossGatewayRoots: vi.fn(),
  getSandbox: vi.fn(),
}));
vi.mock("../../../onboard/runtime-provider/selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../onboard/runtime-provider/selection")>()),
  resolveRegisteredRuntimeProvider: vi.fn(),
}));

describe("maintenance source stop proof", () => {
  const selection = { gatewayName: "recorded", workspace: "default" };
  let entry: registry.SandboxEntry;
  let state: "running" | "paused" | "stopped";
  let resource: string;
  let capture: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    entry = {
      name: "alpha",
      gatewayName: "recorded",
      openshellDriver: "podman",
    } as registry.SandboxEntry;
    state = "running";
    resource = "pinned-container";
    vi.mocked(registry.getSandboxAcrossGatewayRoots).mockImplementation(() => entry);
    capture = vi.fn(() => ({
      schemaVersion: 1,
      providerId: "podman",
      runtime: { kind: "podman-container", handle: resource },
      acceleration: { kind: "none" },
    }));
    vi.mocked(resolveRegisteredRuntimeProvider).mockReturnValue({
      snapshot: {
        supported: true,
        preflight: vi.fn(() => ({ lifecycleState: state })),
        capture,
      },
    } as unknown as NonNullable<ReturnType<typeof resolveRegisteredRuntimeProvider>>);
  });

  it("proves the same pinned runtime stopped through the provider's stable capture", () => {
    const proof = prepareMaintenanceStopProof("alpha", selection, 1_000);
    expect(proof).not.toBeNull();
    state = "stopped";
    expect(proof?.(1_000)).toBe(true);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it.each(["running", "paused"] as const)("refuses a pinned resource still %s", (phase) => {
    const proof = prepareMaintenanceStopProof("alpha", selection, 1_000);
    state = phase;
    expect(proof?.(1_000)).toBe(false);
  });

  it("refuses a replacement resource with the same sandbox name", () => {
    const proof = prepareMaintenanceStopProof("alpha", selection, 1_000);
    state = "stopped";
    resource = "replacement-container";
    expect(proof?.(1_000)).toBe(false);
  });

  it("refuses a runtime generation that changes during provider capture", () => {
    const proof = prepareMaintenanceStopProof("alpha", selection, 1_000);
    state = "stopped";
    capture.mockImplementationOnce(() => {
      throw new Error("stale preflight generation");
    });
    expect(proof?.(1_000)).toBe(false);
  });

  it.each(["gatewayName", "openshellDriver"] as const)("refuses changed registry %s", (field) => {
    const proof = prepareMaintenanceStopProof("alpha", selection, 1_000);
    state = "stopped";
    entry = { ...entry, [field]: "different-owner" };
    expect(proof?.(1_000)).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does not pin authority from another selected gateway", () => {
    expect(
      prepareMaintenanceStopProof("alpha", { ...selection, gatewayName: "other" }, 1_000),
    ).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not substitute the default workspace for another selected workspace", () => {
    expect(
      prepareMaintenanceStopProof("alpha", { ...selection, workspace: "other" }, 1_000),
    ).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not invent running source authority from an already stopped resource", () => {
    state = "stopped";
    expect(prepareMaintenanceStopProof("alpha", selection, 1_000)).toBeNull();
  });

  it("refuses an expired observation budget", () => {
    const proof = prepareMaintenanceStopProof("alpha", selection, 1_000);
    state = "stopped";
    expect(proof?.(0)).toBe(false);
  });
});
