// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerRemoveVolumesByPrefix: vi.fn(),
  spawnSync: vi.fn(),
  stopStaleDashboardListeners: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));
vi.mock("../../adapters/docker/volume", () => ({
  dockerRemoveVolumesByPrefix: mocks.dockerRemoveVolumesByPrefix,
}));
vi.mock("../../onboard/stale-gateway-cleanup", () => ({
  stopStaleDashboardListeners: mocks.stopStaleDashboardListeners,
}));

import { cleanupGatewayAfterLastSandbox } from "./destroy-gateway";

describe("cleanupGatewayAfterLastSandbox runtime evidence", () => {
  const originalStateDir = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  let stateDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (stateDir) fs.rmSync(stateDir, { force: true, recursive: true });
    stateDir = undefined;
    if (originalStateDir === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
    } else {
      process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = originalStateDir;
    }
  });

  it("preserves unverifiable PID evidence so final cleanup can converge on retry (#4662)", () => {
    const pid = 456;
    let pidIsAlive = true;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-gateway-evidence-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    const runtimeMarker = path.join(stateDir, "runtime.json");
    fs.writeFileSync(pidFile, `${pid}\n`);
    fs.writeFileSync(runtimeMarker, '{"evidence":"keep-until-safe"}\n');
    process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = stateDir;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    mocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      const argv = args.map(String);
      if (command === "ps" && argv.join(" ") === `-p ${pid} -o pid=`) {
        return {
          status: pidIsAlive ? 0 : 1,
          stdout: pidIsAlive ? `${pid}\n` : "",
          stderr: "",
        };
      }
      if (command === "ps" && argv.join(" ") === `-p ${pid} -o args=`) {
        return { status: 0, stdout: "unrelated process\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell)).toThrow(
      /PID-file process\(es\) 456.*do not prove ownership/,
    );
    expect(fs.readFileSync(pidFile, "utf-8")).toBe(`${pid}\n`);
    expect(fs.readFileSync(runtimeMarker, "utf-8")).toContain("keep-until-safe");
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
