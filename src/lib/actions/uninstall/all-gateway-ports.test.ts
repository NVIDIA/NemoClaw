// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_GATEWAY_PORTS_ENV,
  type AllGatewayPortsDeps,
  allGatewayPortsRequested,
  runUninstallAllGatewayPorts,
  uninstallChildArgs,
  uninstallChildEnv,
} from "./all-gateway-ports";
import type { UninstallRunDeps, UninstallRunOptions } from "./run-plan";

const OPTIONS: UninstallRunOptions = {
  assumeYes: true,
  deleteModels: false,
  keepOpenShell: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function sweepDeps(overrides: AllGatewayPortsDeps = {}) {
  const error = vi.fn();
  const runPortPass = vi.fn((_port: number) => 0);
  const runSelectedPass = vi.fn(async (_options: UninstallRunOptions, _deps: UninstallRunDeps) => ({
    exitCode: 0,
  }));
  const deps: AllGatewayPortsDeps = {
    env: { HOME: "/home/tester" } as NodeJS.ProcessEnv,
    error,
    home: "/home/tester",
    listGatewayPorts: () => [8080, 18080, 9000],
    log: vi.fn(),
    runPortPass,
    runSelectedPass,
    ...overrides,
  };
  return { deps, error, runPortPass, runSelectedPass };
}

describe("uninstall across every gateway port (#7791)", () => {
  it.each([
    ["the flag alone", undefined, {}, false],
    ["the flag set", true, {}, true],
    ["the environment variable set", undefined, { [ALL_GATEWAY_PORTS_ENV]: "1" }, true],
    ["the environment variable disabled", undefined, { [ALL_GATEWAY_PORTS_ENV]: "0" }, false],
  ] as const)("requests the sweep from %s", (_scenario, flag, env, expected) => {
    expect(allGatewayPortsRequested(flag, env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it("uninstalls each other gateway port in ascending order and the current port last", async () => {
    const { deps, runPortPass, runSelectedPass } = sweepDeps();

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.exitCode).toBe(0);
    expect(result.ports).toEqual([9000, 18080, 8080]);
    expect(runPortPass.mock.calls.map(([port]) => port)).toEqual([9000, 18080]);
    expect(runSelectedPass).toHaveBeenCalledTimes(1);
  });

  it("forces confirmation-free child passes after one whole-host confirmation", async () => {
    const { deps, runSelectedPass } = sweepDeps({ readLine: () => "y" });

    await runUninstallAllGatewayPorts({ ...OPTIONS, assumeYes: false }, deps);

    expect(runSelectedPass.mock.calls[0]?.[0]).toMatchObject({
      assumeYes: true,
    });
  });

  it("does not run any pass when the whole-host confirmation is declined", async () => {
    const { deps, runPortPass, runSelectedPass } = sweepDeps({
      readLine: () => "n",
    });

    const result = await runUninstallAllGatewayPorts({ ...OPTIONS, assumeYes: false }, deps);

    expect(result.exitCode).toBe(0);
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).not.toHaveBeenCalled();
  });

  it("rejects a mismatched gateway check before any port pass", async () => {
    const { deps, error, runPortPass, runSelectedPass } = sweepDeps();

    const result = await runUninstallAllGatewayPorts(
      { ...OPTIONS, gatewayName: "nemoclaw-9000" },
      deps,
    );

    expect(result).toEqual({ exitCode: 1, ports: [] });
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Refusing to uninstall gateway"));
  });

  it("reports a failed port pass and still finishes the remaining ports", async () => {
    const failingPortPass = vi.fn((port: number) => (port === 9000 ? 1 : 0));
    const { deps, error, runSelectedPass } = sweepDeps({
      runPortPass: failingPortPass,
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.exitCode).toBe(1);
    expect(failingPortPass.mock.calls.map(([port]) => port)).toEqual([9000, 18080]);
    expect(runSelectedPass).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("9000"));
  });

  it("carries a failed port into the final pass so shared cleanup stays scoped (#7791)", async () => {
    const { deps, runSelectedPass } = sweepDeps({
      runPortPass: vi.fn((port: number) => (port === 9000 ? 1 : 0)),
    });

    await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(runSelectedPass.mock.calls[0]?.[1]).toMatchObject({
      retainedGatewayPorts: [9000],
    });
  });

  it("returns nonzero when the final pass still observes another gateway environment", async () => {
    const { deps, error } = sweepDeps({
      runSelectedPass: vi.fn(async () => ({
        exitCode: 0,
        otherGatewayEnvironmentsRemain: true,
      })),
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Whole-host uninstall is incomplete"),
    );
  });

  it("retains no port for the final pass when every other port uninstalled", async () => {
    const { deps, runSelectedPass } = sweepDeps();

    await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(runSelectedPass.mock.calls[0]?.[1]).toMatchObject({
      requireCompleteGatewayProcessCleanup: true,
      retainedGatewayPorts: [],
    });
  });

  it("runs a single scoped pass when no other gateway port exists", async () => {
    const { deps, runPortPass, runSelectedPass } = sweepDeps({
      listGatewayPorts: () => [8080],
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.ports).toEqual([8080]);
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).toHaveBeenCalledTimes(1);
    expect(runSelectedPass.mock.calls[0]?.[1]).toMatchObject({
      requireCompleteGatewayProcessCleanup: true,
      retainedGatewayPorts: [],
    });
  });

  it("removes host-global dual-Station credentials when a non-default port finishes the sweep", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-all-ports-"));
    const sharedStateDir = path.join(home, ".nemoclaw");
    const selectedStateDir = path.join(sharedStateDir, "gateways", "9123");
    const apiKeyPath = path.join(sharedStateDir, "dual-station-vllm-api-key");
    fs.mkdirSync(selectedStateDir, { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(selectedStateDir, "selected-only"), "remove me\n");
    fs.writeFileSync(apiKeyPath, "ab".repeat(32), { mode: 0o600 });

    try {
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
      vi.resetModules();
      const { runUninstallAllGatewayPorts: runNonDefaultSweep } =
        await import("./all-gateway-ports");
      const result = await runNonDefaultSweep(OPTIONS, {
        commandExists: () => true,
        env: { HOME: home, NEMOCLAW_GATEWAY_PORT: "9123" },
        existsSync: fs.existsSync,
        hasPortableRuntimeCleanup: () => false,
        home,
        isTty: false,
        kill: () => true,
        listGatewayPorts: () => [8080, 9123],
        log: vi.fn(),
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          gatewayName,
          gatewayPort,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        }),
        rmSync: fs.rmSync,
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json"
            ? {
                status: 0,
                stdout: JSON.stringify([{ name: "nemoclaw-9123" }]),
                stderr: "",
              }
            : { status: 0, stdout: "", stderr: "" },
        runDocker: () => ({ status: 0, stdout: "", stderr: "" }),
        runLocalModelRuntimeCleanup: () => ({
          status: 0,
          stdout: JSON.stringify({ ok: true, removed: [], skipped: [] }),
          stderr: "",
        }),
        runPortPass: () => 0,
      });

      expect(result).toEqual({ exitCode: 0, ports: [8080, 9123] });
      expect(fs.existsSync(apiKeyPath)).toBe(false);
      expect(fs.existsSync(selectedStateDir)).toBe(false);
    } finally {
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("returns nonzero when an undiscovered environment remains after the only selected pass", async () => {
    const { deps, error } = sweepDeps({
      listGatewayPorts: () => [8080],
      runSelectedPass: vi.fn(async () => ({
        exitCode: 0,
        otherGatewayEnvironmentsRemain: true,
      })),
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Whole-host uninstall is incomplete"),
    );
  });

  it("fails without uninstalling anything when the gateway ports cannot be enumerated", async () => {
    const { deps, error, runPortPass, runSelectedPass } = sweepDeps({
      listGatewayPorts: () => {
        throw new Error("gateways/ is a symbolic link");
      },
    });

    const result = await runUninstallAllGatewayPorts(OPTIONS, deps);

    expect(result).toEqual({ exitCode: 1, ports: [] });
    expect(runPortPass).not.toHaveBeenCalled();
    expect(runSelectedPass).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("symbolic link"));
  });

  it("awaits the selected pass when no sibling gateway exists (#9189)", async () => {
    let finish!: () => void;
    const selected = vi.fn(
      () =>
        new Promise<{ exitCode: number }>((resolve) => (finish = () => resolve({ exitCode: 0 }))),
    );
    const { deps, runPortPass } = sweepDeps({
      listGatewayPorts: () => [8080],
      runSelectedPass: selected,
    });
    let completed = false;
    const pending = runUninstallAllGatewayPorts(OPTIONS, deps).then((result) => {
      completed = true;
      return result;
    });

    await Promise.resolve();
    expect(selected).toHaveBeenCalledOnce();
    expect(runPortPass).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    finish();
    await expect(pending).resolves.toEqual({ exitCode: 0, ports: [8080] });
  });

  it("finishes child passes before the awaited selected pass and retains failures (#9189)", async () => {
    const order: string[] = [];
    const { deps } = sweepDeps({
      runPortPass: (port) => {
        order.push(`child:${String(port)}`);
        return port === 9000 ? 1 : 0;
      },
      runSelectedPass: async (_options, selectedDeps) => {
        order.push(`selected:${selectedDeps.retainedGatewayPorts?.join(",")}`);
        await Promise.resolve();
        order.push("selected:done");
        return { exitCode: 0 };
      },
    });

    await expect(runUninstallAllGatewayPorts(OPTIONS, deps)).resolves.toMatchObject({
      exitCode: 1,
    });
    expect(order).toEqual(["child:9000", "child:18080", "selected:9000", "selected:done"]);
  });

  it("maps a selected-pass rejection to exit 1 without a follow-on pass (#9189)", async () => {
    const selected = vi.fn(async () => {
      throw new Error("host fence release failed");
    });
    const { deps, error, runPortPass } = sweepDeps({
      listGatewayPorts: () => [8080],
      runSelectedPass: selected,
    });

    await expect(runUninstallAllGatewayPorts(OPTIONS, deps)).resolves.toEqual({
      exitCode: 1,
      ports: [8080],
    });
    expect(selected).toHaveBeenCalledOnce();
    expect(runPortPass).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("host fence release failed"));
  });

  it("binds each child pass to its own gateway port and drops selected-only state", () => {
    const env = {
      HOME: "/home/tester",
      NEMOCLAW_GATEWAY_PORT: "8080",
      NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: "/srv/nemoclaw/selected-gateway",
      [ALL_GATEWAY_PORTS_ENV]: "1",
    } as NodeJS.ProcessEnv;

    const childEnv = uninstallChildEnv(env, 9000);

    expect(childEnv.NEMOCLAW_GATEWAY_PORT).toBe("9000");
    expect(childEnv.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR).toBeUndefined();
    expect(childEnv[ALL_GATEWAY_PORTS_ENV]).toBeUndefined();
    expect(env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR).toBe("/srv/nemoclaw/selected-gateway");
  });

  it.each([
    [
      "no extra flags",
      {},
      ["internal", "uninstall", "run-plan", "--yes", "--all-gateway-ports-child"],
    ],
    [
      "every passthrough flag",
      { deleteModels: true, destroyUserData: true, keepOpenShell: true },
      [
        "internal",
        "uninstall",
        "run-plan",
        "--yes",
        "--all-gateway-ports-child",
        "--delete-models",
        "--destroy-user-data",
        "--keep-openshell",
      ],
    ],
  ] as const)("passes %s to a child gateway-port pass", (_scenario, overrides, expected) => {
    expect(uninstallChildArgs({ ...OPTIONS, ...overrides })).toEqual(expected);
  });
});
