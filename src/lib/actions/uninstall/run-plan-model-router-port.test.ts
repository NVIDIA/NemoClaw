// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { resolveConfiguredModelRouterPort } from "../../core/ports";
import { runUninstallPlan, type RunResult } from "./run-plan";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const missing = (): RunResult => ({ status: 1, stdout: "", stderr: "" });

it("uses the routed blueprint port to stop an orphan model router", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-router-port-"));
  const blueprintDir = path.join(root, "nemoclaw-blueprint");
  const routerPort = 14000;
  const routerPid = 55680;
  fs.mkdirSync(blueprintDir, { recursive: true });
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
      `    port: ${String(routerPort)}`,
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
        resolveConfiguredModelRouterPort: () => resolveConfiguredModelRouterPort(root),
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
    expect(killed).toContain(routerPid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
