// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerRemoveVolumesByPrefix: vi.fn(),
  resolveGatewayTeardownAuthority: vi.fn(),
  spawnSync: vi.fn(),
  stopStaleDashboardListeners: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));
vi.mock("../../adapters/docker/volume", () => ({
  dockerRemoveVolumesByPrefix: mocks.dockerRemoveVolumesByPrefix,
}));
vi.mock("../../onboard/gateway-teardown-authority", () => ({
  resolveGatewayTeardownAuthority: mocks.resolveGatewayTeardownAuthority,
}));
vi.mock("../../onboard/stale-gateway-cleanup", () => ({
  stopStaleDashboardListeners: mocks.stopStaleDashboardListeners,
}));

import { cleanupGatewayAfterLastSandbox } from "./destroy-gateway";

describe("cleanupGatewayAfterLastSandbox runtime evidence", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-gateway-evidence-"));
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", stateDir);
    mocks.resolveGatewayTeardownAuthority.mockImplementation(
      ({ gatewayName, gatewayPort }: { gatewayName: string; gatewayPort: number }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { force: true, recursive: true });
  });

  it("preserves unverifiable PID evidence so final cleanup can converge on retry (#4662)", () => {
    const pid = 456;
    let pidIsAlive = true;
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    const runtimeMarker = path.join(stateDir, "runtime.json");
    fs.writeFileSync(pidFile, `${pid}\n`);
    fs.writeFileSync(runtimeMarker, '{"evidence":"keep-until-safe"}\n');
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const missingProcess = () => ({ status: 1, stdout: "", stderr: "" });
    const processResponses = new Map([
      [
        `ps -p ${pid} -o pid=`,
        () => ({
          status: pidIsAlive ? 0 : 1,
          stdout: pidIsAlive ? `${pid}\n` : "",
          stderr: "",
        }),
      ],
      [`ps -p ${pid} -o args=`, () => ({ status: 0, stdout: "openclaw-gateway\n", stderr: "" })],
    ]);
    mocks.spawnSync.mockImplementation((command: string, args: string[]) =>
      (processResponses.get(`${command} ${args.map(String).join(" ")}`) ?? missingProcess)(),
    );
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell)).toThrow(
      /PID-file process\(es\) 456.*do not prove ownership/,
    );
    expect(fs.readFileSync(pidFile, "utf-8")).toBe(`${pid}\n`);
    expect(fs.readFileSync(runtimeMarker, "utf-8")).toContain("keep-until-safe");
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["gateway", "remove", "nemoclaw-8081"],
      expect.anything(),
    );
    expect(mocks.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();

    pidIsAlive = false;
    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell)).not.toThrow();
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(runtimeMarker)).toBe(false);
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw-8081"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(mocks.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith(
      "openshell-cluster-nemoclaw-8081",
      { ignoreError: true },
    );
  });
});
