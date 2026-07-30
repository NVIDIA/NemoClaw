// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildPodmanDriverGatewayEnv } from "../../../onboard/compute/podman/gateway-env";
import { createPodmanSandboxCreateRuntimeAuthority } from "../../../onboard/compute/podman/sandbox-create-authority";
import { createPodmanOpenShellWatcherController } from "../../../onboard/compute/podman/sandbox-recreate";
import type { PodmanSocketAuthority } from "../../../onboard/compute/podman/socket-authority";
import type { SandboxRuntimeAuthorityAdapterRegistry } from "../../../onboard/compute/runtime-authority";
import type { SandboxEntry } from "../../../state/registry";
import {
  createPodmanManagedSnapshotRuntimeAuthority,
  currentManagedSnapshotRuntimeAuthorityAdapters,
  resolveManagedSnapshotRuntimeAuthority,
} from "./runtime-authority";
import type { ManagedSnapshotRuntimePatchContext } from "./runtime-patch";

function context(driverName: string): ManagedSnapshotRuntimePatchContext {
  return {
    destinationSandboxName: "beta",
    sourceEntry: {
      gatewayName: "nemoclaw-8443",
      gatewayPort: 8443,
      name: "alpha",
      openshellDriver: driverName,
    } as SandboxEntry,
  };
}

describe("managed snapshot runtime authority", () => {
  it("routes exact source context to the Podman authority adapter", () => {
    const authority = {
      socketAuthority: {
        directoryChain: [],
        device: "8",
        inode: "9001",
        ownerUid: "1001",
        socketPath: "/run/user/1001/podman/podman.sock",
      },
      socketPath: "/run/user/1001/podman/podman.sock",
      watcherController: createPodmanOpenShellWatcherController({
        assertStopped: vi.fn(),
        resumeAndProve: vi.fn(),
        stopAndProve: vi.fn(() => ({ stopped: true })),
      }),
    };
    const createPodman = vi.fn(() => authority);
    const input = context("podman");

    expect(
      resolveManagedSnapshotRuntimeAuthority(
        "podman",
        input,
        currentManagedSnapshotRuntimeAuthorityAdapters(createPodman),
      ),
    ).toBe(authority);
    expect(createPodman).toHaveBeenCalledWith(input);
  });

  it("keeps direct drivers authority-free", () => {
    const adapters = currentManagedSnapshotRuntimeAuthorityAdapters(vi.fn());
    expect(
      resolveManagedSnapshotRuntimeAuthority("docker", context("docker"), adapters),
    ).toBeNull();
    expect(
      resolveManagedSnapshotRuntimeAuthority("kubernetes", context("kubernetes"), adapters),
    ).toBeNull();
  });

  it("accepts an independently registered MXC authority adapter", () => {
    const authority = { endpoint: "unix:///run/mxc/runtime.sock" };
    const adapters: SandboxRuntimeAuthorityAdapterRegistry<ManagedSnapshotRuntimePatchContext> = {
      mxc: { driverName: "mxc", resolve: vi.fn(() => authority) },
    };

    expect(resolveManagedSnapshotRuntimeAuthority("mxc", context("mxc"), adapters)).toBe(authority);
  });

  it("qualifies the recovered Podman API before composing mutable snapshot authority", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-authority-"));
    try {
      const config = 'compute_drivers = ["podman"]\n';
      fs.writeFileSync(path.join(stateDir, "openshell-gateway.toml"), config, { mode: 0o600 });
      fs.writeFileSync(
        path.join(stateDir, "managed-runtime.json"),
        `${JSON.stringify({
          version: 1,
          driverName: "podman",
          configSha256: createHash("sha256").update(config).digest("hex"),
          values: {
            network_name: "openshell",
            socket_path: "/run/user/1000/podman/podman.sock",
            supervisor_image: `ghcr.io/nvidia/openshell/supervisor@sha256:${"a".repeat(64)}`,
          },
        })}\n`,
        { mode: 0o600 },
      );
      const qualifyRecoveryRuntime = vi.fn(() => {
        throw new Error("rootless Podman API is unavailable");
      });
      const getOpenshellBinary = vi.fn(() => "/usr/bin/openshell");

      expect(() =>
        createPodmanManagedSnapshotRuntimeAuthority(context("podman"), {
          captureOpenshell: vi.fn(() => ({ output: "" })),
          getOpenshellBinary,
          qualifyRecoveryRuntime,
          resolveGatewayPortFromName: vi.fn(() => 8443),
          resolveManagedGatewayStateDirectory: vi.fn(() => stateDir),
          resolveSandboxGatewayName: vi.fn(() => "nemoclaw-8443"),
          runCapture: vi.fn(() => ""),
        }),
      ).toThrow("rootless Podman API is unavailable");
      expect(qualifyRecoveryRuntime).toHaveBeenCalledOnce();
      expect(getOpenshellBinary).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("threads the qualified socket receipt and rejects replacement before watcher composition", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-authority-"));
    const previousGatewayBin = process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN;
    try {
      const socketPath = "/run/user/1000/podman/podman.sock";
      buildPodmanDriverGatewayEnv({
        gatewayPort: 8443,
        podmanSocketPath: socketPath,
        stateDir,
        supervisorImage: `ghcr.io/nvidia/openshell/supervisor@sha256:${"a".repeat(64)}`,
      });
      const socketAuthority: PodmanSocketAuthority = {
        directoryChain: [],
        device: "8",
        inode: "9001",
        ownerUid: "1000",
        socketPath,
      };
      const qualifyRecoveryRuntime = vi.fn(() => ({
        architecture: "amd64" as const,
        cgroupVersion: "v2" as const,
        driverName: "podman" as const,
        networkBackend: "netavark",
        os: "linux" as const,
        rootless: true as const,
        socketAuthority,
        socketPath,
        version: "5.0.0",
      }));
      const assertSocketAuthority = vi.fn(() => {
        throw new Error("Podman socket authority changed after it was qualified.");
      });
      const createWatcherController = vi.fn(() => {
        throw new Error("watcher composition must not run after authority replacement");
      });
      process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN = "/bin/sh";

      expect(() =>
        createPodmanManagedSnapshotRuntimeAuthority(context("podman"), {
          captureOpenshell: vi.fn(() => ({ output: "" })),
          createRuntimeAuthority: (input) =>
            createPodmanSandboxCreateRuntimeAuthority(input, {
              assertSocketAuthority,
              createWatcherController,
            }),
          getOpenshellBinary: vi.fn(() => "/usr/bin/openshell"),
          qualifyRecoveryRuntime,
          resolveGatewayPortFromName: vi.fn(() => 8443),
          resolveManagedGatewayStateDirectory: vi.fn(() => stateDir),
          resolveSandboxGatewayName: vi.fn(() => "nemoclaw-8443"),
          runCapture: vi.fn(() => ""),
        }),
      ).toThrow("Podman socket authority changed after it was qualified.");
      expect(qualifyRecoveryRuntime).toHaveBeenCalledOnce();
      expect(assertSocketAuthority).toHaveBeenCalledExactlyOnceWith(socketAuthority);
      expect(createWatcherController).not.toHaveBeenCalled();
    } finally {
      if (previousGatewayBin === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN = previousGatewayBin;
      }
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });
});
