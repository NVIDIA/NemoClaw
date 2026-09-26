// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { runUninstallPlan, type RunResult } from "./run-plan";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const missing = (): RunResult => ({ status: 1, stdout: "", stderr: "" });

it("uses the recorded router port when the current blueprint changed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-router-port-"));
  const blueprintDir = path.join(root, "nemoclaw-blueprint");
  const stateDir = path.join(root, ".nemoclaw");
  const routerPort = 14000;
  const routerPid = 55680;
  fs.mkdirSync(blueprintDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "onboard-session.json"),
    JSON.stringify({ provider: "nvidia-router", routerPort }),
  );
  fs.writeFileSync(
    path.join(blueprintDir, "blueprint.yaml"),
    [
      "components:",
      "  inference:",
      "    profiles:",
      "      routed:",
      "        model: test/model",
      "  router:",
      "    enabled: true",
      "    port: 15000",
      "",
    ].join("\n"),
  );
  const killed: number[] = [];
  const errors: string[] = [];
  const exited = new Set<number>();
  const run = vi.fn((command: string, args: string[]): RunResult => {
    switch (command) {
      case "lsof":
        return args[1] === `:${String(routerPort)}` ? ok(`${String(routerPid)}\n`) : ok();
      case "ps":
        switch (args[3]) {
          case "user=":
            return ok("testuser\n");
          case "args=":
            return ok(
              `/home/test/.nemoclaw/model-router-venv/bin/python /home/test/.nemoclaw/model-router-venv/bin/model-router proxy --port ${String(routerPort)}\n`,
            );
          case "pid=":
          case "stat=":
            return exited.has(routerPid) ? missing() : ok(`${String(routerPid)}\n`);
          default:
            return missing();
        }
      case "openshell":
        return args[0] === "gateway" && args[1] === "list"
          ? ok(JSON.stringify([{ name: "nemoclaw" }]))
          : ok();
      default:
        return args[0] === "-c" ? ok("/fake/bin/tool\n") : ok();
    }
  });

  try {
    const result = await runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: root, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
        error: (message) => errors.push(message),
        existsSync: () => false,
        isTty: false,
        kill: (pid) => {
          killed.push(pid);
          exited.add(pid);
          return true;
        },
        log: () => undefined,
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          endpoint: null,
          gatewayName,
          gatewayPort,
          mode: "nemoclaw-managed",
          requiredCapabilities: [],
          source: "packaged-service",
          stateDir: null,
          supervisor: null,
        }),
        rmSync: vi.fn(),
        run,
        runDocker: () => ok(),
      },
    );

    expect(result.exitCode, errors.join("\n")).toBe(0);
    expect(run).toHaveBeenCalledWith("lsof", ["-ti", `:${String(routerPort)}`], {
      env: expect.any(Object),
    });
    expect(run).not.toHaveBeenCalledWith("lsof", ["-ti", ":15000"], expect.anything());
    expect(killed).toContain(routerPid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("reports incomplete cleanup instead of guessing when a legacy router session has no port", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-router-no-port-"));
  const stateDir = path.join(root, ".nemoclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "onboard-session.json"),
    JSON.stringify({ provider: "nvidia-router", routerPid: 55681 }),
  );
  const errors: string[] = [];
  const killed: number[] = [];
  const logs: string[] = [];
  const run = vi.fn((command: string, args: string[]): RunResult => {
    return command === "openshell" && args[0] === "gateway" && args[1] === "list"
      ? ok(JSON.stringify([{ name: "nemoclaw" }]))
      : args[0] === "-c"
        ? ok("/fake/bin/tool\n")
        : ok();
  });

  try {
    const result = await runUninstallPlan(
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
      {
        commandExists: () => true,
        env: { HOME: root, LOGNAME: "testuser" } as NodeJS.ProcessEnv,
        error: (message) => errors.push(message),
        existsSync: () => false,
        isTty: false,
        kill: (pid) => {
          killed.push(pid);
          return true;
        },
        log: (message) => logs.push(message),
        resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
          endpoint: null,
          gatewayName,
          gatewayPort,
          mode: "nemoclaw-managed",
          requiredCapabilities: [],
          source: "packaged-service",
          stateDir: null,
          supervisor: null,
        }),
        rmSync: fs.rmSync,
        run,
        runDocker: () => ok(),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(errors).toContainEqual(expect.stringContaining("recorded port is missing"));
    expect(errors).toContainEqual(expect.stringContaining("PID 55681"));
    expect(errors).toContainEqual(expect.stringContaining("rerun nemoclaw uninstall"));
    expect(run).not.toHaveBeenCalledWith("lsof", ["-ti", ":4000"], expect.anything());
    expect(killed).toEqual([]);
    expect(logs.some((line) => line.endsWith("State and binaries"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "onboard-session.json"))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
