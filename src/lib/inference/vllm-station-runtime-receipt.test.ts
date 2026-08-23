// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DUAL_STATION_VLLM_RUNTIME,
  type DualStationVllmPlan,
  probeDualStationVllmCapability,
} from "./vllm-station-cluster";
import {
  cleanupInstalledDualStationVllmRuntime,
  dualStationVllmRuntimeReceiptPath,
  persistDualStationVllmRuntimeReceipt,
  recoverInstalledDualStationVllmRuntime,
} from "./vllm-station-runtime-receipt";
import {
  createDualStationSshBindingFixture,
  type DualStationSshBindingFixture,
} from "./vllm-station-ssh-binding.test-support";

let root: string;
let stateDir: string;
let sshFixture: DualStationSshBindingFixture;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dual-runtime-receipt-"));
  stateDir = path.join(root, ".nemoclaw");
  sshFixture = createDualStationSshBindingFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  sshFixture.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

function plan(): DualStationVllmPlan {
  return {
    peerSshBinding: sshFixture.binding,
    runtime: DUAL_STATION_VLLM_RUNTIME,
    local: {
      hostname: "station-a",
      home: "/home/nvidia",
      uid: 1000,
      gid: 1000,
      gpu: {
        index: 0,
        name: "NVIDIA GB300",
        uuid: "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        totalMemoryMiB: 100_000,
        freeMemoryMiB: 95_000,
      },
    },
    peer: {
      hostname: "station-b",
      home: "/home/nvidia",
      uid: 1000,
      gid: 1000,
      gpu: {
        index: 0,
        name: "NVIDIA GB300",
        uuid: "GPU-99999999-8888-7777-6666-555555555555",
        totalMemoryMiB: 100_000,
        freeMemoryMiB: 95_000,
      },
    },
    rails: [
      {
        index: 0,
        subnet: "192.168.240.0/30",
        local: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8r0",
          macAddress: "02:00:00:00:00:01",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0001:03:00.0",
          address: "192.168.240.1",
        },
        peer: {
          rdmaDevice: "mlx5_0",
          netdev: "cx8r0",
          macAddress: "02:00:00:00:00:02",
          uverbsDevice: "/dev/infiniband/uverbs0",
          pciAddress: "0002:03:00.0",
          address: "192.168.240.2",
        },
      },
      {
        index: 1,
        subnet: "192.168.240.4/30",
        local: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8r1",
          macAddress: "02:00:00:00:00:05",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0001:03:00.1",
          address: "192.168.240.5",
        },
        peer: {
          rdmaDevice: "mlx5_1",
          netdev: "cx8r1",
          macAddress: "02:00:00:00:00:06",
          uverbsDevice: "/dev/infiniband/uverbs1",
          pciAddress: "0002:03:00.1",
          address: "192.168.240.6",
        },
      },
    ],
    masterAddress: "192.168.240.1",
    roceGidIndex: 3,
  };
}

describe("dual-Station vLLM runtime rollback receipt", () => {
  it("uses the host-global state root across gateway ports", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18080");
    vi.resetModules();

    const firstGateway = await import("./vllm-station-runtime-receipt");
    const expectedPlan = plan();
    firstGateway.persistDualStationVllmRuntimeReceipt(expectedPlan);

    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "18081");
    vi.resetModules();
    const secondGateway = await import("./vllm-station-runtime-receipt");

    expect(secondGateway.dualStationVllmRuntimeReceiptPath()).toBe(
      path.join(root, ".nemoclaw", "dual-station-vllm-runtime.json"),
    );
    expect(
      secondGateway.recoverInstalledDualStationVllmRuntime({
        probeCapability: () => ({
          kind: "ready",
          plan: expectedPlan,
          peerModelSnapshot: "ready",
        }),
      }),
    ).toEqual({
      kind: "ready",
      plan: expectedPlan,
    });
  });

  it("recovers a released non-default-gateway receipt without duplicating ownership", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const legacyStateDir = path.join(root, ".nemoclaw", "gateways", "18080");
    const expectedPlan = plan();
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir: legacyStateDir });

    expect(
      recoverInstalledDualStationVllmRuntime({
        probeCapability: () => ({
          kind: "ready",
          plan: expectedPlan,
          peerModelSnapshot: "ready",
        }),
      }),
    ).toEqual({ kind: "ready", plan: expectedPlan });

    persistDualStationVllmRuntimeReceipt(expectedPlan, {
      probeCapability: () => ({
        kind: "ready",
        plan: expectedPlan,
        peerModelSnapshot: "ready",
      }),
    });
    expect(fs.existsSync(dualStationVllmRuntimeReceiptPath())).toBe(false);
    expect(fs.existsSync(dualStationVllmRuntimeReceiptPath(legacyStateDir))).toBe(true);
  });

  it("rejects ambiguous receipts across shared and legacy gateway roots", () => {
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const expectedPlan = plan();
    const sharedStateDir = path.join(root, ".nemoclaw");
    const legacyStateDir = path.join(sharedStateDir, "gateways", "18080");
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir: sharedStateDir });
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir: legacyStateDir });
    const probeCapability = vi.fn();

    expect(recoverInstalledDualStationVllmRuntime({ probeCapability })).toEqual({
      kind: "unsafe",
      reason: "Multiple dual-Station vLLM runtime receipts were found; ownership is ambiguous",
    });
    expect(probeCapability).not.toHaveBeenCalled();
  });

  it("writes a private cleanup receipt and removes both exact containers before retiring it", async () => {
    const expectedPlan = plan();
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir });
    const receiptPath = dualStationVllmRuntimeReceiptPath(stateDir);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(`${receiptPath}.ssh-binding`).isDirectory()).toBe(true);

    const cleanupManagedVllm = vi.fn(async () => ({
      ok: true as const,
      removedContainerIds: ["worker-id", "head-id"],
    }));
    const probeCapability = vi.fn(() => ({
      kind: "ready" as const,
      plan: expectedPlan,
      peerModelSnapshot: "ready" as const,
    }));

    await expect(
      cleanupInstalledDualStationVllmRuntime({
        stateDir,
        cleanupManagedVllm,
        probeCapability,
      }),
    ).resolves.toEqual({
      kind: "removed",
      removedContainerIds: ["worker-id", "head-id"],
    });
    expect(cleanupManagedVllm).toHaveBeenCalledWith(expectedPlan);
    expect(fs.existsSync(receiptPath)).toBe(false);
    expect(fs.existsSync(`${receiptPath}.ssh-binding`)).toBe(false);
  });

  it("preserves rollback state when the qualified pair no longer matches", async () => {
    const expectedPlan = plan();
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir });
    const changedPlan = {
      ...expectedPlan,
      peer: {
        ...expectedPlan.peer,
        gpu: {
          ...expectedPlan.peer.gpu,
          uuid: "GPU-bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        },
      },
    };
    const cleanupManagedVllm = vi.fn();

    await expect(
      cleanupInstalledDualStationVllmRuntime({
        stateDir,
        cleanupManagedVllm,
        probeCapability: () => ({
          kind: "ready",
          plan: changedPlan,
          peerModelSnapshot: "ready",
        }),
      }),
    ).rejects.toThrow("runtime identity changed");
    expect(cleanupManagedVllm).not.toHaveBeenCalled();
    expect(fs.existsSync(dualStationVllmRuntimeReceiptPath(stateDir))).toBe(true);
  });

  it("refuses to overwrite rollback ownership with a different pair", () => {
    const expectedPlan = plan();
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir });
    const receiptPath = dualStationVllmRuntimeReceiptPath(stateDir);
    const original = fs.readFileSync(receiptPath, "utf8");
    const changedPlan = {
      ...expectedPlan,
      peer: {
        ...expectedPlan.peer,
        gpu: {
          ...expectedPlan.peer.gpu,
          uuid: "GPU-bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        },
      },
    };

    expect(() => persistDualStationVllmRuntimeReceipt(changedPlan, { stateDir })).toThrow(
      "different managed dual-Station runtime receipt",
    );
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(original);
  });

  it("recovers the exact installed pair through its private peer binding", () => {
    const expectedPlan = plan();
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir });
    let recoveredEnv: NodeJS.ProcessEnv | undefined;
    const probeCapability = vi.fn(
      (options: Parameters<typeof probeDualStationVllmCapability>[0]) => {
        recoveredEnv = options?.env;
        return {
          kind: "ready" as const,
          plan: expectedPlan,
          peerModelSnapshot: "ready" as const,
        };
      },
    );

    expect(recoverInstalledDualStationVllmRuntime({ stateDir, probeCapability })).toEqual({
      kind: "ready",
      plan: expectedPlan,
    });
    expect(probeCapability).toHaveBeenCalledOnce();
    expect(recoveredEnv?.NEMOCLAW_DGX_STATION_PEER).toBe(expectedPlan.peerSshBinding.peerTarget);
    expect(recoveredEnv?.NEMOCLAW_DGX_STATION_SSH_BINDING).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("reports that no installed pair can be recovered without a receipt", () => {
    const probeCapability = vi.fn();

    expect(recoverInstalledDualStationVllmRuntime({ stateDir, probeCapability })).toEqual({
      kind: "not-installed",
    });
    expect(probeCapability).not.toHaveBeenCalled();
  });

  it("rejects a malformed recovery receipt before probing the peer", () => {
    fs.mkdirSync(stateDir, { mode: 0o700 });
    fs.writeFileSync(dualStationVllmRuntimeReceiptPath(stateDir), "{\n", { mode: 0o600 });
    const probeCapability = vi.fn();

    expect(recoverInstalledDualStationVllmRuntime({ stateDir, probeCapability })).toMatchObject({
      kind: "unsafe",
      reason: expect.stringContaining("malformed"),
    });
    expect(probeCapability).not.toHaveBeenCalled();
  });

  it("rejects recovered peer evidence that can no longer be revalidated", () => {
    persistDualStationVllmRuntimeReceipt(plan(), { stateDir });

    expect(
      recoverInstalledDualStationVllmRuntime({
        stateDir,
        probeCapability: () => ({
          kind: "unavailable",
          code: "peer-ssh-config-unsafe",
          reason: "installer-qualified Station SSH binding is invalid or changed",
        }),
      }),
    ).toEqual({
      kind: "unsafe",
      reason:
        "could not revalidate the managed pair: installer-qualified Station SSH binding is invalid or changed",
    });
  });

  it("rejects a recovered pair whose immutable runtime identity changed", () => {
    const expectedPlan = plan();
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir });
    const changedPlan = {
      ...expectedPlan,
      peer: {
        ...expectedPlan.peer,
        gpu: {
          ...expectedPlan.peer.gpu,
          uuid: "GPU-bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        },
      },
    };

    expect(
      recoverInstalledDualStationVllmRuntime({
        stateDir,
        probeCapability: () => ({
          kind: "ready",
          plan: changedPlan,
          peerModelSnapshot: "ready",
        }),
      }),
    ).toEqual({
      kind: "unsafe",
      reason: "could not revalidate the managed pair: managed runtime identity changed",
    });
  });

  it("refuses a symbolic-link receipt before peer probing or cleanup", async () => {
    const receiptPath = dualStationVllmRuntimeReceiptPath(stateDir);
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const target = path.join(root, "redirected-receipt.json");
    fs.writeFileSync(target, "{}\n", { mode: 0o600 });
    fs.symlinkSync(target, receiptPath);
    const probeCapability = vi.fn();
    const cleanupManagedVllm = vi.fn();

    await expect(
      cleanupInstalledDualStationVllmRuntime({
        stateDir,
        probeCapability,
        cleanupManagedVllm,
      }),
    ).rejects.toThrow("symbolic link");
    expect(probeCapability).not.toHaveBeenCalled();
    expect(cleanupManagedVllm).not.toHaveBeenCalled();
  });

  it("refuses a non-private receipt before peer probing or cleanup", async () => {
    const expectedPlan = plan();
    persistDualStationVllmRuntimeReceipt(expectedPlan, { stateDir });
    fs.chmodSync(dualStationVllmRuntimeReceiptPath(stateDir), 0o644);
    const probeCapability = vi.fn();
    const cleanupManagedVllm = vi.fn();

    await expect(
      cleanupInstalledDualStationVllmRuntime({
        stateDir,
        probeCapability,
        cleanupManagedVllm,
      }),
    ).rejects.toThrow("private regular file");
    expect(probeCapability).not.toHaveBeenCalled();
    expect(cleanupManagedVllm).not.toHaveBeenCalled();
  });

  it("does nothing when no managed pair receipt exists", async () => {
    await expect(
      cleanupInstalledDualStationVllmRuntime({
        stateDir,
        probeCapability: vi.fn(),
        cleanupManagedVllm: vi.fn(),
      }),
    ).resolves.toEqual({ kind: "not-installed" });
  });
});
