// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hasOpenShellVmDriverChildProcessFromPsOutput } from "../dist/lib/onboard/vm-driver-process.js";

const {
  areRequiredDockerDriverBinariesPresent,
  findReadableNvidiaCdiSpecFiles,
  getDockerDriverGatewayEnv,
  getDockerDriverGatewayRuntimeDriftFromSnapshot,
  getGatewayStartEnv,
  isDockerDriverGatewayPortListener,
  isLinuxDockerDriverGatewayEnabled,
  parseDockerCdiSpecDirs,
  shouldAllowOpenshellAboveBlueprintMax,
  shouldRequireDockerDriverEnv,
} = require("../dist/lib/onboard") as {
  areRequiredDockerDriverBinariesPresent: (
    platform?: NodeJS.Platform,
    binaries?: {
      gatewayBin?: string | null;
      sandboxBin?: string | null;
      vmDriverBin?: string | null;
    },
    arch?: NodeJS.Architecture,
  ) => boolean;
  findReadableNvidiaCdiSpecFiles: (dirs: string[]) => string[];
  getDockerDriverGatewayEnv: (
    versionOutput?: string | null,
    platform?: NodeJS.Platform,
  ) => Record<string, string>;
  getDockerDriverGatewayRuntimeDriftFromSnapshot: (snapshot: {
    processEnv: Record<string, string> | null;
    processExe: string | null;
    desiredEnv: Record<string, string>;
    gatewayBin?: string | null;
  }) => { reason: string } | null;
  getGatewayStartEnv: () => Record<string, string>;
  isDockerDriverGatewayPortListener: (
    portCheck: {
      ok: boolean;
      process?: string;
      pid?: number | null;
    },
    opts?: {
      platform?: NodeJS.Platform;
      arch?: NodeJS.Architecture;
      gatewayBin?: string | null;
      isPidAliveFn?: (pid: number) => boolean;
      isDockerDriverGatewayProcessFn?: (pid: number, gatewayBin?: string | null) => boolean;
    },
  ) => boolean;
  isLinuxDockerDriverGatewayEnabled: (
    platform?: NodeJS.Platform,
    arch?: NodeJS.Architecture,
  ) => boolean;
  parseDockerCdiSpecDirs: (value?: string | null) => string[];
  shouldAllowOpenshellAboveBlueprintMax: (
    versionOutput?: string | null,
    platform?: NodeJS.Platform,
    env?: NodeJS.ProcessEnv,
  ) => boolean;
  shouldRequireDockerDriverEnv: (platform?: NodeJS.Platform) => boolean;
};

describe("onboard gateway runtime helpers", () => {
  it("models the OpenShell standalone gateway environment", () => {
    expect(isLinuxDockerDriverGatewayEnabled("linux")).toBe(true);
    expect(isLinuxDockerDriverGatewayEnabled("darwin", "arm64")).toBe(true);
    expect(isLinuxDockerDriverGatewayEnabled("darwin", "x64")).toBe(false);
    expect(isLinuxDockerDriverGatewayEnabled("win32")).toBe(false);
    const linuxEnv = getDockerDriverGatewayEnv("openshell 0.0.37", "linux");
    expect(linuxEnv.OPENSHELL_DRIVERS).toBe("docker");
    expect(linuxEnv.OPENSHELL_BIND_ADDRESS).toBe("127.0.0.1");
    expect(linuxEnv.OPENSHELL_GRPC_ENDPOINT).toBe("http://127.0.0.1:8080");
    expect(linuxEnv.OPENSHELL_SSH_GATEWAY_HOST).toBe("127.0.0.1");
    expect(linuxEnv.OPENSHELL_CLUSTER_IMAGE).toBeUndefined();
    expect(linuxEnv.OPENSHELL_DOCKER_SUPERVISOR_IMAGE).toContain(":0.0.37");

    const darwinEnv = getDockerDriverGatewayEnv("openshell 0.0.37", "darwin");
    expect(darwinEnv.OPENSHELL_DRIVERS).toBe("docker");
    expect(darwinEnv.OPENSHELL_BIND_ADDRESS).toBe("127.0.0.1");
    expect(darwinEnv.OPENSHELL_GRPC_ENDPOINT).toBe("http://127.0.0.1:8080");
    expect(darwinEnv.OPENSHELL_SSH_GATEWAY_HOST).toBe("127.0.0.1");
    expect(darwinEnv.OPENSHELL_DOCKER_SUPERVISOR_IMAGE).toContain(":0.0.37");
    expect(darwinEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBeUndefined();
    expect(darwinEnv.OPENSHELL_VM_DRIVER_STATE_DIR).toBeUndefined();

    const originalOverlayFix = process.env.NEMOCLAW_DISABLE_OVERLAY_FIX;
    process.env.NEMOCLAW_DISABLE_OVERLAY_FIX = "1";
    try {
      expect(getGatewayStartEnv()).toMatchObject({
        OPENSHELL_BIND_ADDRESS: "127.0.0.1",
        OPENSHELL_SERVER_PORT: "8080",
        OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
        OPENSHELL_SSH_GATEWAY_PORT: "8080",
      });
    } finally {
      if (originalOverlayFix === undefined) {
        delete process.env.NEMOCLAW_DISABLE_OVERLAY_FIX;
      } else {
        process.env.NEMOCLAW_DISABLE_OVERLAY_FIX = originalOverlayFix;
      }
    }
  });

  it("requires platform-specific standalone gateway binaries", () => {
    expect(
      areRequiredDockerDriverBinariesPresent(
        "darwin",
        {
          gatewayBin: "/tmp/openshell-gateway",
          sandboxBin: null,
          vmDriverBin: "/tmp/openshell-driver-vm",
        },
        "arm64",
      ),
    ).toBe(true);
    expect(
      areRequiredDockerDriverBinariesPresent("linux", {
        gatewayBin: "/tmp/openshell-gateway",
        sandboxBin: null,
        vmDriverBin: null,
      }),
    ).toBe(false);
    expect(
      areRequiredDockerDriverBinariesPresent("linux", {
        gatewayBin: "/tmp/openshell-gateway",
        sandboxBin: "/tmp/openshell-sandbox",
        vmDriverBin: null,
      }),
    ).toBe(true);
    expect(
      areRequiredDockerDriverBinariesPresent(
        "darwin",
        {
          gatewayBin: "/tmp/openshell-gateway",
          sandboxBin: null,
          vmDriverBin: null,
        },
        "arm64",
      ),
    ).toBe(true);
    expect(
      areRequiredDockerDriverBinariesPresent(
        "darwin",
        {
          gatewayBin: null,
          sandboxBin: "/tmp/openshell-sandbox",
          vmDriverBin: "/tmp/openshell-driver-vm",
        },
        "arm64",
      ),
    ).toBe(false);
    expect(
      areRequiredDockerDriverBinariesPresent(
        "darwin",
        {
          gatewayBin: null,
          sandboxBin: null,
          vmDriverBin: null,
        },
        "arm64",
      ),
    ).toBe(false);
    expect(
      areRequiredDockerDriverBinariesPresent(
        "darwin",
        {
          gatewayBin: null,
          sandboxBin: null,
        },
        "x64",
      ),
    ).toBe(true);
  });

  it("requires Docker-driver process env verification only where /proc is available", () => {
    expect(shouldRequireDockerDriverEnv("linux")).toBe(true);
    expect(shouldRequireDockerDriverEnv("darwin")).toBe(false);
    expect(shouldRequireDockerDriverEnv("win32")).toBe(false);
  });

  it("detects VM-driver children attached to a macOS standalone gateway", () => {
    const psOutput = [
      " 1000     1 /Users/me/.local/bin/openshell-gateway",
      " 1001  1000 /Users/me/.local/bin/openshell-driver-vm --bind-socket /tmp/compute.sock",
      " 1002  1001 /Users/me/.local/bin/openshell-driver-vm --internal-run-vm",
      " 1003  1000 /usr/bin/other-process",
    ].join("\n");
    expect(hasOpenShellVmDriverChildProcessFromPsOutput(1000, psOutput)).toBe(true);
    expect(hasOpenShellVmDriverChildProcessFromPsOutput(1001, psOutput)).toBe(true);
    expect(hasOpenShellVmDriverChildProcessFromPsOutput(1003, psOutput)).toBe(false);
  });

  it("detects stale Docker-driver gateway runtime state before reuse", () => {
    const desiredEnv = getDockerDriverGatewayEnv("openshell 0.0.37", "linux");
    const gatewayBin = process.execPath;

    expect(
      getDockerDriverGatewayRuntimeDriftFromSnapshot({
        processEnv: desiredEnv,
        processExe: gatewayBin,
        desiredEnv,
        gatewayBin,
      }),
    ).toBeNull();

    expect(
      getDockerDriverGatewayRuntimeDriftFromSnapshot({
        processEnv: {
          ...desiredEnv,
          OPENSHELL_DOCKER_SUPERVISOR_IMAGE:
            "ghcr.io/nvidia/openshell/supervisor:0.0.36",
        },
        processExe: gatewayBin,
        desiredEnv,
        gatewayBin,
      })?.reason,
    ).toContain("OPENSHELL_DOCKER_SUPERVISOR_IMAGE=");

    expect(
      getDockerDriverGatewayRuntimeDriftFromSnapshot({
        processEnv: {
          ...desiredEnv,
          OPENSHELL_BIND_ADDRESS: "0.0.0.0",
        },
        processExe: gatewayBin,
        desiredEnv,
        gatewayBin,
      })?.reason,
    ).toContain("OPENSHELL_BIND_ADDRESS=");

    expect(
      getDockerDriverGatewayRuntimeDriftFromSnapshot({
        processEnv: desiredEnv,
        processExe: `${gatewayBin} (deleted)`,
        desiredEnv,
        gatewayBin,
      })?.reason,
    ).toContain("replaced on disk");

    expect(
      getDockerDriverGatewayRuntimeDriftFromSnapshot({
        processEnv: null,
        processExe: gatewayBin,
        desiredEnv,
        gatewayBin,
      })?.reason,
    ).toContain("process environment");
  });

  it("recognizes an existing Docker-driver gateway listener on Docker-driver platforms", () => {
    const opts = {
      platform: "linux" as NodeJS.Platform,
      isPidAliveFn: (pid: number) => pid === 1234,
      isDockerDriverGatewayProcessFn: (pid: number, gatewayBin?: string | null) =>
        pid === 1234 && gatewayBin === "/opt/openshell/openshell-gateway",
      gatewayBin: "/opt/openshell/openshell-gateway",
    };
    expect(
      isDockerDriverGatewayPortListener({ ok: false, process: "openshell", pid: 1234 }, opts),
    ).toBe(true);
    expect(
      isDockerDriverGatewayPortListener({ ok: false, process: "openshell-", pid: 1234 }, opts),
    ).toBe(true);
    expect(
      isDockerDriverGatewayPortListener({ ok: false, process: "node", pid: 1234 }, opts),
    ).toBe(false);
    expect(
      isDockerDriverGatewayPortListener(
        { ok: false, process: "openshell", pid: 1234 },
        { ...opts, platform: "darwin", arch: "arm64" },
      ),
    ).toBe(true);
    expect(
      isDockerDriverGatewayPortListener(
        { ok: false, process: "openshell", pid: 1234 },
        { ...opts, platform: "win32" },
      ),
    ).toBe(false);
    expect(
      isDockerDriverGatewayPortListener(
        { ok: false, process: "openshell", pid: 4321 },
        { ...opts, isPidAliveFn: () => false },
      ),
    ).toBe(false);
  });

  it("recognizes Docker CDI and explicit dev-channel version gates", () => {
    expect(parseDockerCdiSpecDirs('["/etc/cdi","/var/run/cdi"]')).toEqual([
      "/etc/cdi",
      "/var/run/cdi",
    ]);
    expect(parseDockerCdiSpecDirs("")).toEqual([]);
    expect(
      shouldAllowOpenshellAboveBlueprintMax("openshell 0.0.40.dev1+gabcdef", "linux", {
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      }),
    ).toBe(true);
    expect(
      shouldAllowOpenshellAboveBlueprintMax("openshell 0.0.40.dev1+gabcdef", "linux", {
        NEMOCLAW_OPENSHELL_CHANNEL: "auto",
      }),
    ).toBe(false);
    expect(
      shouldAllowOpenshellAboveBlueprintMax("openshell 0.0.40", "linux", {
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
      }),
    ).toBe(false);
  });

  it("requires readable NVIDIA CDI spec files, not just CDI directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cdi-specs-"));
    try {
      const emptyDir = path.join(tmpDir, "empty");
      const cdiDir = path.join(tmpDir, "cdi");
      fs.mkdirSync(emptyDir);
      fs.mkdirSync(cdiDir);
      fs.writeFileSync(path.join(cdiDir, "unrelated.yaml"), "kind: example.com/device\n");
      expect(findReadableNvidiaCdiSpecFiles([emptyDir, cdiDir])).toEqual([]);

      const specPath = path.join(cdiDir, "gpu-devices.yaml");
      fs.writeFileSync(
        specPath,
        ["cdiVersion: 0.6.0", "kind: nvidia.com/gpu", "devices:", "  - name: all", ""].join(
          "\n",
        ),
      );
      expect(findReadableNvidiaCdiSpecFiles([emptyDir, cdiDir])).toEqual([specPath]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
